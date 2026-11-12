// v0.4 · Aeropuerto de cada tramo de fotos, sabiendo solo matrículas y la hora de la cámara.
// El workflow del ADS-B saca cada día UTC un índice mundial de escalas (TODO/AAAA-MM-DD.json.gz, de adsb.lol):
// para cada matrícula, en qué aeropuertos estuvo y de qué hora a qué hora. Aquí se busca el aeropuerto donde estaban
// las matrículas de cada tramo a la hora de sus fotos.
//
// La hora de la cámara no se sabe de antemano (puede ir en hora de casa estando de viaje, o con la hora de verano sin
// cambiar). Se prueban desfases de −12 h a +14 h y se elige el que pone a las matrículas en un aeropuerto; entre los
// que empatan, uno «creíble»: la hora de casa o la local del aeropuerto, ± 1 h. Con una sola matrícula solo se acepta
// un desfase creíble; con dos o más que coinciden, cualquiera (la cámara podía ir en la hora de otro sitio).
//
// Tiempos: «pared» = hora de la cámara tal cual, como si fuera UTC (ms). h = minutos que la cámara va por delante de
// UTC: instante UTC = pared − h.

const MIN = 60000, DIA = 86400000;
const MARGEN = 20 * 60;   // s: foto del aterrizaje o del despegue, un poco antes o después de la estancia
const clave = r => String(r || '').replace(/\(.*?\)/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const fecha = ms => new Date(ms).toISOString().slice(0, 10);

// Desfases a probar (min): de −12 h a +14 h cada 15 min
export const DESFASES = Array.from({ length: (840 + 720) / 15 + 1 }, (_, i) => -720 + i * 15);

// Minutos que una zona horaria va por delante de UTC en ese instante
const fmts = new Map();
export function desfaseZona(tz, ms) {
  if (!tz) return null;
  try {
    let f = fmts.get(tz);
    if (!f) fmts.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(ms / MIN) * MIN) / MIN);
  } catch { return null; }
}
// Desfase de la hora de casa (la zona del navegador) en esa fecha
export const desfaseCasa = ms => -new Date(ms).getTimezoneOffset();

// Días UTC del índice que hacen falta para situar las fotos con desfases entre hMin y hMax
export function diasNecesarios(paredes, hMin = -720, hMax = 840) {
  const out = new Set();
  for (const p of paredes) {
    const a = p - hMax * MIN - MARGEN * 1000, b = p - hMin * MIN + MARGEN * 1000;
    for (let t = Date.parse(fecha(a) + 'T00:00:00Z'); t <= b; t += DIA) out.add(fecha(t));
  }
  return [...out].sort();
}

// ¿Dónde estaba la matrícula en el instante T (ms UTC)? → Map aeropuerto → puntuación (1 dentro, 0,75 en el margen,
// 0,4 «pudo estar»: entre el último punto antes y el primero después de un hueco sin datos). null = no hay datos ese día.
export function dondeEstaba(indices, reg, T) {
  const k = clave(reg), f = fecha(T), idx = indices.get(f);
  if (!idx) return null;
  const s = (T - Date.parse(f + 'T00:00:00Z')) / 1000, out = new Map();
  const poner = (a, v) => { if (v > (out.get(a) || 0)) out.set(a, v); };
  const est = idx.aviones[k]?.[2];
  if (est) {
    for (const [a, ini, fin, min, max] of est) {
      if (s >= ini && s <= fin) poner(a, 1);
      else if (s >= ini - MARGEN && s <= fin + MARGEN) poner(a, 0.75);
      else if ((min == null || s >= min) && (max == null || s <= max)) poner(a, 0.4);
    }
    return out;
  }
  // ese día no voló ni se le vio: estaba donde se quedó el día anterior o donde amaneció el siguiente
  const ant = indices.get(fecha(T - DIA))?.aviones[k]?.[2], sig = indices.get(fecha(T + DIA))?.aviones[k]?.[2];
  const u = ant?.[ant.length - 1], p = sig?.[0];
  if (u && u[4] == null) poner(u[0], 0.4);
  if (p && p[3] == null) poner(p[0], 0.4);
  return out;
}

// tramos: [{ id, consultas: [{ reg, pared }] }] · indices: Map fecha → doc del índice (con .aviones y .zonas)
// Devuelve Map id → { apt, h, puntos, apoyos, total, sinDatos, alternativa, creible } (o { sinDatos } / { dudoso })
export function detectar(tramos, indices, { casa = desfaseCasa } = {}) {
  const zonas = {};
  for (const d of indices.values()) Object.assign(zonas, d.zonas || {});
  const creible = (h, a, ms) => {
    const c = casa(ms), z = desfaseZona(zonas[a], ms);
    return Math.abs(h - c) <= 60 || (z != null && Math.abs(h - z) <= 60);
  };
  // para cada tramo y desfase: puntuación de cada aeropuerto
  const tabla = new Map();
  for (const t of tramos) {
    const porH = new Map(), conDatosSet = new Set();
    for (const h of DESFASES) {
      const pts = new Map(), fuertes = new Map();
      for (const [i, c] of t.consultas.entries()) {
        const m = dondeEstaba(indices, c.reg, c.pared - h * MIN);
        if (!m) continue;
        conDatosSet.add(i);
        for (const [a, v] of m) { pts.set(a, (pts.get(a) || 0) + v); if (v >= 0.75) fuertes.set(a, (fuertes.get(a) || 0) + 1); }
      }
      porH.set(h, { pts, fuertes });
    }
    tabla.set(t.id, { porH, conDatos: conDatosSet.size });
  }
  // mejor aeropuerto de un tramo con un desfase dado (y el segundo, para saber si está claro)
  const mejorCon = (t, h) => {
    const { pts, fuertes } = tabla.get(t.id).porH.get(h);
    const ms = t.consultas[0]?.pared - h * MIN;
    const orden = [...pts].map(([a, p]) => {
      const f = fuertes.get(a) || 0, cr = creible(h, a, ms);
      // sin un desfase creíble hacen falta dos matrículas fuertes en el mismo sitio
      const valido = f >= 1 && (cr || f >= 2);
      return { a, p, f, cr, valido, nota: valido ? p + (cr ? 0.3 : 0) : 0 };
    }).sort((x, y) => y.nota - x.nota);
    return { mejor: orden[0], segundo: orden[1] };
  };
  // la cámara es una: se busca el desfase que mejor sitúa a todos los tramos a la vez
  let hGlobal = null, maxG = 0;
  for (const h of DESFASES) {
    let s = 0;
    for (const t of tramos) { const { mejor } = mejorCon(t, h); if (mejor?.valido) s += mejor.nota; }
    // a igualdad, una hora en punto (las cámaras van con horas enteras de diferencia) y la más cercana a la de casa
    const c = tramos[0]?.consultas[0] ? casa(tramos[0].consultas[0].pared) : 0;
    const desempate = x => (x % 60 === 0 ? 0 : x % 30 === 0 ? 1000 : 2000) + Math.abs(x - c);
    if (s > maxG + 1e-9 || (Math.abs(s - maxG) < 1e-9 && s > 0 && desempate(h) < desempate(hGlobal))) { maxG = s; hGlobal = h; }
  }
  const out = new Map();
  for (const t of tramos) {
    const total = t.consultas.length, conDatos = tabla.get(t.id).conDatos;
    if (!total || !conDatos) { out.set(t.id, { sinDatos: true, total, conDatos }); continue; }
    // primero con el desfase de toda la carpeta; si este tramo no encaja, con el suyo propio (¿se cambió la hora?)
    let h = hGlobal, r = h == null ? {} : mejorCon(t, h);
    if (!r.mejor?.valido) {
      let best = null;
      for (const hh of DESFASES) { const x = mejorCon(t, hh); if (x.mejor?.valido && (!best || x.mejor.nota > best.r.mejor.nota)) best = { hh, r: x }; }
      if (best) { h = best.hh; r = best.r; }
    }
    const m = r.mejor;
    if (!m?.valido) { out.set(t.id, { dudoso: true, total, conDatos }); continue; }
    const seg = r.segundo?.valido ? r.segundo : null;
    const claro = !seg || m.nota - seg.nota >= 0.5;
    out.set(t.id, { apt: m.a, h, puntos: Math.round(m.p * 100) / 100, apoyos: m.f, total, conDatos, creible: m.cr, claro,
      alternativa: seg ? seg.a : '', propio: h !== hGlobal });
  }
  return out;
}
