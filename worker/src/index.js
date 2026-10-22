// Publica en Instagram lo que toca segun https://danihweb-publicar.vercel.app/datos.json
// (reels, posts en video, carruseles, posts de dato; historias y regalo no). Cron cada 15 min.
// Cada tick avanza una etapa por pieza (crear contenedores -> armar carrusel -> publicar) para no pasar el limite de subrequests.
const API = 'https://graph.instagram.com/v23.0';
const DATOS = 'https://danihweb-publicar.vercel.app/datos.json';
const TIPOS = ['Reel', 'Post en video', 'Carrusel', 'Post de dato'];
const ANTES = 30 * 60e3;      // empieza a preparar 30 min antes de la hora, para publicar puntual
const VENTANA = 6 * 3600e3;   // si algo falla, publica hasta 6 h tarde; mas viejo se salta

async function api(token, metodo, ruta, p = {}) {
  const q = new URLSearchParams({ ...p, access_token: token });
  const r = await fetch(metodo === 'GET' ? `${API}/${ruta}?${q}` : `${API}/${ruta}`, metodo === 'GET' ? {} : { method: 'POST', body: q });
  const j = await r.json();
  if (!r.ok) throw new Error(`${ruta}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

async function token(env) {
  let t = JSON.parse((await env.KV.get('token')) || 'null') || { token: env.IG_TOKEN, expira: env.IG_EXPIRA };
  if ((Date.parse(t.expira) - Date.now()) / 864e5 < 15) {   // dura 60 dias; se renueva sola
    const r = await (await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${t.token}`)).json();
    if (r.access_token) t = { token: r.access_token, expira: new Date(Date.now() + r.expires_in * 1e3).toISOString().slice(0, 10) };
  }
  await env.KV.put('token', JSON.stringify(t));
  return t.token;
}

// hora de Caracas (UTC-4, sin horario de verano) -> ms UTC
function toca(fecha, hora) {
  const [, h, m, ap] = hora.match(/(\d+):(\d+)\s*(am|pm)/i);
  return Date.parse(`${fecha}T00:00:00Z`) + (((+h % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0)) * 60 + +m + 240) * 60e3;
}

const esVideo = (a) => a.tipo === 'video/mp4';
const contenedor = (t, a, extra = {}) =>
  api(t, 'POST', 'me/media', esVideo(a) ? { media_type: 'REELS', video_url: a.url, ...extra } : { image_url: a.url, ...extra }).then((r) => r.id);
const estado = async (t, id) => (await api(t, 'GET', id, { fields: 'status_code' })).status_code;

// avanza una pieza una o mas etapas; devuelve su nuevo estado
async function avanzar(t, pz, s, ahora, hora, probar) {
  if (!s.etapa) {
    if (pz.tipo === 'Carrusel' && pz.archivos.length > 1)
      s.hijos = await Promise.all(pz.archivos.slice(0, 20).map((a) => esVideo(a)
        ? api(t, 'POST', 'me/media', { media_type: 'VIDEO', video_url: a.url, is_carousel_item: 'true' }).then((r) => r.id)
        : contenedor(t, a, { is_carousel_item: 'true' })));
    else s.cid = await contenedor(t, pz.archivos[0], { caption: pz.texto });
    s.etapa = 'creado';
  }
  if (s.hijos && !s.cid) {
    const st = await Promise.all(s.hijos.map((h) => estado(t, h)));
    if (st.some((x) => x === 'ERROR' || x === 'EXPIRED')) throw new Error('un item del carrusel fallo: ' + st.join());
    if (st.every((x) => x === 'FINISHED'))
      s.cid = (await api(t, 'POST', 'me/media', { media_type: 'CAROUSEL', children: s.hijos.join(','), caption: pz.texto })).id;
    else return s;
  }
  const st = await estado(t, s.cid);
  if (st === 'ERROR' || st === 'EXPIRED') throw new Error('Meta rechazo el contenedor: ' + st);
  if (st !== 'FINISHED') return s;
  s.etapa = 'listo';
  if (probar || ahora < hora) return s;   // listo, esperando su hora
  s.media_id = (await api(t, 'POST', 'me/media_publish', { creation_id: s.cid })).id;
  s.etapa = 'publicado'; s.cuando = new Date(ahora).toISOString();
  return s;
}

async function tick(env, probar = false) {
  const ahora = Date.now(), log = [];
  const hoy = new Date(ahora - 4 * 3600e3).toISOString().slice(0, 10);   // fecha en Caracas
  const dias = (await (await fetch(DATOS)).json()).dias;
  const t = await token(env);
  for (const d of dias.filter((d) => d.fecha === hoy))
    for (const pz of d.piezas) {
      if (!TIPOS.includes(pz.tipo) || pz.falta || !pz.archivos?.length) continue;
      const clave = `p:${d.fecha}/${pz.id}`, hora = toca(d.fecha, pz.hora);
      let s = JSON.parse((await env.KV.get(clave)) || '{}');
      if (s.etapa === 'publicado' || s.etapa === 'error' || (!probar && (ahora < hora - ANTES || ahora > hora + VENTANA))) continue;
      try { s = await avanzar(t, pz, s, ahora, hora, probar); log.push(`${clave}: ${s.etapa}`); }
      catch (e) { s.intentos = (s.intentos || 0) + 1; s.error = String(e).slice(0, 300); if (s.intentos >= 3) s.etapa = 'error'; log.push(`${clave}: FALLO ${s.error}`); }
      await env.KV.put(clave, JSON.stringify(s), { expirationTtl: 1209600 });
      if (probar) return log;
    }
  return log;
}

export default {
  async scheduled(_, env, ctx) { ctx.waitUntil(tick(env).then((l) => console.log(l.join('\n')))); },
  // GET /?clave=...&probar=1  -> prepara la proxima pieza sin publicar; sin probar = corre un tick normal
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.searchParams.get('clave') !== env.CLAVE) return new Response('no', { status: 403 });
    return Response.json(await tick(env, u.searchParams.has('probar')));
  },
};
