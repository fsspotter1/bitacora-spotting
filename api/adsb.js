// v0.3 · Cruce con ADS-B. La web dice qué aeropuerto y qué días (hora de la cámara) tiene la carpeta; aquí se pasan a
// días UTC con la zona horaria del aeropuerto, se apuntan en Supabase (pedir_adsb) y, si un día aún no está procesado,
// se lanza el workflow de GitHub Actions que lo descarga de adsb.lol y lo filtra (.github/workflows/adsb.yml).
// v0.4 · El código especial TODO pide el índice mundial de escalas de esos días (para detectar el aeropuerto de cada
// tramo de fotos por sus matrículas): no tiene zona horaria, así que la web manda directamente los días UTC.
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   GITHUB_TOKEN_ADSB   token de GitHub (fine-grained, solo este repositorio, permiso Actions: Read and write)
//   ADSB_REPO           opcional; por defecto Fsspotter1/bitacora-spotting

const SUPABASE_URL = 'https://vhhpbulykxiqfwarxlfu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_lXi2rPoZx8ofeM46jqwBlA_PaSQ2JSX'; // clave pública (la misma que la web)
const AEROPUERTOS = require('../data/aeropuertos.json');   // ICAO → [lat, lon, elevación ft, zona horaria]
const DESDE = '2023-03-10';                                  // primer día con historial en adsb.lol

// Minutos que la zona va por delante de UTC en ese instante
function desfaseZona(tz, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000);
}
// Hora de pared (como si fuera UTC) → UTC real en esa zona
function paredAUtc(pared, tz) {
  if (!tz) return pared;
  const o1 = desfaseZona(tz, pared), u = pared - o1 * 60000, o2 = desfaseZona(tz, u);
  return o1 === o2 ? u : pared - o2 * 60000;
}
const dia = ms => new Date(ms).toISOString().slice(0, 10);

async function usuario(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
  return r.ok ? r.json() : null;
}

async function rpc(token, fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error(j?.message || `Supabase ${r.status}`); e.status = r.status; e.code = j?.code; throw e; }
  return j;
}

async function lanzar(fecha, aeropuerto) {
  const repo = process.env.ADSB_REPO || 'Fsspotter1/bitacora-spotting';
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/adsb.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN_ADSB}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bitacora-spotting', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { fecha, aeropuertos: aeropuerto } }),
  });
  if (r.status !== 204) {
    const j = await r.json().catch(() => null);
    throw new Error(`GitHub respondió ${r.status}${j?.message ? ': ' + j.message : ''}`);
  }
}

module.exports = async function handler(req, res) {
  // GET: comprobación rápida de que el servidor tiene el token de GitHub (no devuelve nada secreto)
  if (req.method === 'GET') return res.status(200).json({ adsb: !!process.env.GITHUB_TOKEN_ADSB });
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Usa POST' }); }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const u = token && await usuario(token).catch(() => null);
  if (!u?.id) return res.status(401).json({ error: 'sin_sesion', mensaje: 'Vuelve a entrar en la web.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const apt = String(body?.aeropuerto || '').toUpperCase().trim();
  const escalas = apt === 'TODO';
  const info = escalas ? [null, null, null, ''] : AEROPUERTOS[apt];
  if (!/^[A-Z0-9]{4}$/.test(apt) || !info) return res.status(400).json({ error: 'aeropuerto', mensaje: `No conozco el aeropuerto «${apt}». Usa el código ICAO de 4 letras (LEVC, LEMD…).` });
  const [lat, lon, elev, tz] = info;

  // Días UTC: los que pide la web directamente, o los que cubren las horas de la cámara (± 30 min) en la zona del aeropuerto
  const fechas = new Set();
  for (const f of Array.isArray(body.fechas) ? body.fechas : []) if (/^\d{4}-\d{2}-\d{2}$/.test(f)) fechas.add(f);
  for (const r of !escalas && Array.isArray(body.rangos) ? body.rangos : []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r?.dia) || !/^\d\d:\d\d$/.test(r.desde) || !/^\d\d:\d\d$/.test(r.hasta)) continue;
    const a = paredAUtc(Date.parse(`${r.dia}T${r.desde}:00Z`), tz) - 30 * 60000, b = paredAUtc(Date.parse(`${r.dia}T${r.hasta}:00Z`), tz) + 30 * 60000;
    for (let t = Date.parse(dia(a) + 'T00:00:00Z'); t <= b; t += 86400000) fechas.add(dia(t));
  }
  const lista = [...fechas].sort().slice(0, escalas ? 21 : 14);
  const hoy = dia(Date.now());
  const estados = {}, mensajes = {};
  const base = { aeropuerto: apt, lat, lon, elev, tz, fechas: lista, estados, mensajes };
  if (!lista.length) return res.status(200).json(base);

  const conToken = !!process.env.GITHUB_TOKEN_ADSB;
  for (const f of lista) {
    if (f < DESDE) { estados[f] = 'sin_datos'; mensajes[f] = 'adsb.lol tiene historial desde marzo de 2023.'; continue; }
    if (f >= hoy) { estados[f] = 'aun_no'; mensajes[f] = 'El día UTC aún no ha terminado: adsb.lol lo publica unas horas después de medianoche UTC.'; continue; }
    if (!conToken) { estados[f] = 'sin_clave'; continue; }
    try {
      const e = await rpc(token, 'pedir_adsb', { p_aeropuerto: apt, p_fecha: f });
      if (e !== 'lanzar') { estados[f] = e; continue; }
      try { await lanzar(f, apt); estados[f] = 'pendiente'; }
      catch (err) {
        console.error('adsb lanzar:', err);
        estados[f] = 'error'; mensajes[f] = 'No se pudo lanzar el procesado: ' + String(err.message).slice(0, 160);
        await rpc(token, 'soltar_adsb', { p_aeropuerto: apt, p_fecha: f, p_mensaje: mensajes[f] }).catch(() => {});
      }
    } catch (err) {
      if (err.status === 404 || err.code === 'PGRST202') return res.status(503).json({ ...base, error: 'sin_tabla', mensaje: 'Falta ejecutar supabase/v0.3.sql en Supabase.' });
      estados[f] = 'error'; mensajes[f] = String(err.message).slice(0, 160);
    }
  }
  if (!conToken && lista.some(f => estados[f] === 'sin_clave')) {
    return res.status(503).json({ ...base, error: 'sin_clave', mensaje: 'El cruce con ADS-B aún no está activado en el servidor.' });
  }
  return res.status(200).json(base);
};
