Publicador de Instagram de DANIHWEB.

- Principal: Cloudflare Worker `worker/` (cron cada 15 min, estado en KV). Lee https://danihweb-publicar.vercel.app/datos.json y publica reels, posts en video, carruseles y posts de dato a su hora (Caracas). Prepara 30 min antes y publica puntual.
- Respaldo: `publicar.py` + workflow de GitHub, solo manual (workflow_dispatch). No lo corras junto al Worker o duplica publicaciones.
- Token de IG: secreto `IG_TOKEN` del Worker; se renueva solo en KV cuando le quedan menos de 15 dias.
- Probar sin publicar: GET <worker>/?clave=<CLAVE>&probar=1
