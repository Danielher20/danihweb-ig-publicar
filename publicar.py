"""Publica en Instagram, por la API oficial, lo que toca a esta hora segun
https://danihweb-publicar.vercel.app/datos.json (reels, posts en video, carruseles, posts de dato).
Las historias y el regalo no se tocan. Corre en GitHub Actions cada 15 min.

  python publicar.py            publica lo que toca y anota en publicado.json
  python publicar.py --probar   crea el contenedor de la proxima pieza y espera que Meta lo apruebe, sin publicar
"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

API = 'https://graph.instagram.com/v23.0'
DATOS = 'https://danihweb-publicar.vercel.app/datos.json'
TZ = ZoneInfo('America/Caracas')          # horas de la app, sin horario de verano
VENTANA = timedelta(hours=6)              # si GitHub o la luz fallan, se publica hasta 6 h tarde; mas viejo se salta
TIPOS = {'Reel', 'Post en video', 'Carrusel', 'Post de dato'}
ESTADO = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'publicado.json')
TOKEN = os.environ['IG_TOKEN']


def llamar(metodo, ruta, **p):
    p['access_token'] = TOKEN
    url, datos = f'{API}/{ruta}', urllib.parse.urlencode(p).encode()
    if metodo == 'GET': url, datos = f'{url}?{datos.decode()}', None
    try:
        return json.load(urllib.request.urlopen(urllib.request.Request(url, datos, method=metodo), timeout=120))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{ruta}: {e.read().decode()[:400]}') from None


def hora(txt):                            # '12:00 pm' -> (12, 0)
    h, resto = txt.split(':'); m, ap = resto.split()
    return (int(h) % 12) + (12 if ap.lower() == 'pm' else 0), int(m)


def esperar(cid):
    for _ in range(60):                   # hasta 10 min
        st = llamar('GET', cid, fields='status_code,status')
        if st['status_code'] == 'FINISHED': return
        if st['status_code'] in ('ERROR', 'EXPIRED'): raise RuntimeError(f'{cid}: {st}')
        time.sleep(10)
    raise RuntimeError(f'{cid}: Meta no termino de procesar en 10 min')


def contenedor(archivo, **extra):
    video = archivo['tipo'] == 'video/mp4'
    base = {'media_type': 'REELS' if video else None, 'video_url' if video else 'image_url': archivo['url']} | extra
    return llamar('POST', 'me/media', **{k: v for k, v in base.items() if v})['id']


def preparar(pz):
    arch, caption = pz['archivos'], pz['texto']
    if pz['tipo'] == 'Carrusel' and len(arch) > 1:
        hijos = [contenedor(a, is_carousel_item='true') if a['tipo'] != 'video/mp4'
                 else llamar('POST', 'me/media', media_type='VIDEO', video_url=a['url'], is_carousel_item='true')['id'] for a in arch[:20]]
        for h in hijos: esperar(h)
        cid = llamar('POST', 'me/media', media_type='CAROUSEL', children=','.join(hijos), caption=caption)['id']
    else:
        cid = contenedor(arch[0], caption=caption)
    esperar(cid)
    return cid


def main():
    probar = '--probar' in sys.argv
    hecho = json.load(open(ESTADO, encoding='utf-8')) if os.path.exists(ESTADO) else {}
    ahora = datetime.now(TZ)
    dias = json.load(urllib.request.urlopen(DATOS, timeout=60))['dias']
    for d in dias:
        if d['fecha'] != ahora.date().isoformat(): continue
        for pz in d['piezas']:
            clave = f"{d['fecha']}/{pz['id']}"
            if pz['tipo'] not in TIPOS or clave in hecho or pz.get('falta') or not pz.get('archivos'): continue
            h, m = hora(pz['hora']); toca = ahora.replace(hour=h, minute=m, second=0, microsecond=0)
            if not probar and not (toca <= ahora <= toca + VENTANA): continue
            print('->', clave, pz['tipo'], pz['hora'])
            try:
                cid = preparar(pz)
                if probar: print('contenedor aprobado por Meta, no se publica:', cid); return
                hecho[clave] = {'media_id': llamar('POST', 'me/media_publish', creation_id=cid)['id'], 'cuando': ahora.isoformat(timespec='minutes')}
                print('publicado', hecho[clave])
            except Exception as e:   # una pieza mala no frena las demas ni se reintenta en bucle infinito: queda en el log
                print('FALLO', clave, e); hecho[clave] = {'error': str(e)[:300], 'cuando': ahora.isoformat(timespec='minutes')}
            json.dump(hecho, open(ESTADO, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
