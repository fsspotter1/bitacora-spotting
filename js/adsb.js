// v0.3 · Cruce con ADS-B (datos abiertos de adsb.lol, licencia ODbL: se cita «adsb.lol»).
// El servidor guarda, por aeropuerto y día UTC, las trazas de los aviones que pasaron a menos de 15 km. Aquí, en el
// navegador, se cruzan con las ráfagas:
//   1. Hora de la cámara → UTC: se supone que la cámara iba en la hora local del aeropuerto y se calibra el desfase
//      con las ráfagas cuya matrícula ya se conoce (leída por la IA o escrita a mano): el desfase bueno es el que pone
//      a todos esos aviones en el aeropuerto, y cerca unos de otros, a la hora de su foto.
//   2. Candidatos de cada ráfaga: los aviones que a esa hora estaban aterrizando, despegando, rodando o parados,
//      ordenados por cercanía a la zona donde salen los demás aviones fotografiados, tipo, matrícula parcial y operador.
//   3. Resultado: matrícula confirmada, posible error de lectura, matrícula propuesta (solo si es la única que encaja)
//      o una lista corta de candidatos para elegir con un clic.
// Igual que en ia.js (aquí aparte para que este módulo no dependa del resto de la web)
export const claveReg = r => String(r || '').replace(/\(.*?\)/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export const ADSB_DESDE = '2023-03-10';
const SUELO = -1;
const MIN = 60000;
const KM = (la1, lo1, la2, lo2) => Math.hypot((la1 - la2) * 111.2, (lo1 - lo2) * 111.2 * Math.cos((la1 + la2) / 360 * Math.PI));

/* ---------------- hora ---------------- */
const fmts = new Map();
function desfaseZona(tz, ms) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / MIN);
}
// raw.js guarda la hora EXIF como fecha local del navegador: aquí se recupera la hora «de pared» de la cámara
export function paredDe(t) { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()); }
// Hora de pared → UTC en la zona del aeropuerto
export function paredAUtc(pared, tz) {
  if (!tz) return pared;
  try {
    const o1 = desfaseZona(tz, pared), u = pared - o1 * MIN, o2 = desfaseZona(tz, u);
    return o1 === o2 ? u : pared - o2 * MIN;
  } catch { return pared; }
}
// Hora local del aeropuerto (HH:MM) de un instante UTC
export const horaAeropuerto = (ms, tz) => { try { return new Date(ms).toLocaleTimeString('es-ES', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

// Días de la cámara con la primera y la última hora de cada uno (el servidor los pasa a días UTC)
export function rangosCamara(bursts) {
  const m = new Map();
  for (const b of bursts) {
    for (const f of [b.frames[0], b.frames[b.frames.length - 1]]) {
      const iso = new Date(paredDe(f.t)).toISOString(), d = iso.slice(0, 10), h = iso.slice(11, 16);
      const r = m.get(d) || { dia: d, desde: h, hasta: h };
      if (h < r.desde) r.desde = h;
      if (h > r.hasta) r.hasta = h;
      m.set(d, r);
    }
  }
  return [...m.values()];
}

/* ---------------- datos ---------------- */
export async function descargarDia(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`no se pudo descargar (${r.status})`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const txt = buf[0] === 0x1f && buf[1] === 0x8b
    ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(buf);
  return JSON.parse(txt);
}

// Junta los días de un aeropuerto en una lista de aviones con sus puntos en orden (T en ms UTC)
export function juntarDias(docs) {
  docs = docs.filter(Boolean).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const porHex = new Map();
  for (const doc of docs) {
    const base = Date.parse(doc.fecha + 'T00:00:00Z');
    for (const av of doc.aviones) {
      let x = porHex.get(av.h);
      if (!x) porHex.set(av.h, x = { h: av.h, r: '', t: '', d: '', mil: false, T: [], la: [], lo: [], al: [], gs: [], cs: [] });
      x.r ||= av.r; x.t ||= av.t; x.d ||= av.d; x.mil ||= !!av.mil;
      for (const p of av.p) { x.T.push(base + p[0] * 1000); x.la.push(p[1] / 1e5); x.lo.push(p[2] / 1e5); x.al.push(p[3]); x.gs.push(p[4]); }
      for (const c of av.cs || []) x.cs.push([base + c[0] * 1000, c[1]]);
    }
  }
  const aviones = [...porHex.values()].filter(x => x.T.length);
  const porReg = new Map(), d0 = docs[0];
  const ref = d0 && { lat: d0.lat, lon: d0.lon, elev: d0.elev || 0 };
  for (const x of aviones) {
    x.ref = ref;
    x.reg = claveReg(x.r); x.tf = familia(x.t); x.ini = x.T[0]; x.fin = x.T[x.T.length - 1]; x.presente = presencia(x);
    x.vehiculo = !x.r && !x.t && x.al.every(a => a === SUELO);   // coches de pista con transpondedor
    if (x.reg && !porReg.has(x.reg)) porReg.set(x.reg, x);
  }
  return { apt: d0 && { icao: d0.aeropuerto, lat: d0.lat, lon: d0.lon, elev: d0.elev, tz: d0.tz }, aviones, porReg, fechas: docs.map(d => d.fecha) };
}

/* ---------------- dónde estaba cada avión ---------------- */
function indice(arr, T) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < T) lo = m + 1; else hi = m; } return lo; }
// Aparcado entre los puntos a y b: los dos en tierra en el mismo sitio (transpondedor apagado en el stand) o, en
// aeropuertos sin cobertura en tierra, a llega bajo y b sale bajo junto al aeropuerto (aterrizó y luego despegó)
// (a tiene que ir bajando y b subiendo: un despegue seguido de un aterrizaje es un vuelo de ida y vuelta, no un aparcado)
const bajoCerca = (av, i) => av.ref && (av.al[i] === SUELO || (av.al[i] >= 0 && av.al[i] <= av.ref.elev + 2500)) && KM(av.la[i], av.lo[i], av.ref.lat, av.ref.lon) < 6;
const llega = (av, i) => av.al[i] === SUELO || (i > 0 && av.al[i - 1] >= av.al[i] && av.al[i - 1] !== SUELO);
const sale = (av, i) => av.al[i] === SUELO || (i < av.T.length - 1 && av.al[i + 1] >= av.al[i]);
const aparcadoEntre = (av, a, b) => av.T[b] - av.T[a] <= 8 * 3600000 && (
  (av.al[a] === SUELO && av.al[b] === SUELO && KM(av.la[a], av.lo[a], av.la[b], av.lo[b]) < 0.3)
  || (av.T[b] - av.T[a] > 10 * MIN && bajoCerca(av, a) && bajoCerca(av, b) && llega(av, a) && sale(av, b)));

// Posición del avión en T: interpolada entre dos puntos cercanos (≤ 2 min), el punto más próximo (≤ 1 min), o
// «aparcado» si entre dos puntos en tierra en el mismo sitio hay un hueco largo (transpondedor apagado en el stand).
export function estadoEn(av, T) {
  if (T < av.ini - MIN || T > av.fin + MIN) return null;
  const n = av.T.length, b = indice(av.T, T), a = b - 1;
  if (a >= 0 && b < n) {
    const dt = av.T[b] - av.T[a];
    if (dt <= 2 * MIN) {
      const f = dt ? (T - av.T[a]) / dt : 0, k = f < 0.5 ? a : b;
      const gs = av.gs[a] >= 0 && av.gs[b] >= 0 ? av.gs[a] + (av.gs[b] - av.gs[a]) * f : Math.max(av.gs[a], av.gs[b]);
      return { T, k, lat: av.la[a] + (av.la[b] - av.la[a]) * f, lon: av.lo[a] + (av.lo[b] - av.lo[a]) * f, al: av.al[k], gs };
    }
    if (aparcadoEntre(av, a, b)) return { T, k: a, lat: av.la[a], lon: av.lo[a], al: SUELO, gs: 0, aparcado: true };
  }
  const k = a >= 0 && T - av.T[a] <= MIN ? a : b < n && av.T[b] - T <= MIN ? b : -1;
  return k < 0 ? null : { T, k, lat: av.la[k], lon: av.lo[k], al: av.al[k], gs: av.gs[k] };
}
// Tiempo total que se le puede situar (para saber si un avión «ancla» sirve para calibrar: uno aparcado todo el día no)
function presencia(av) {
  let s = 2 * MIN;
  for (let i = 1; i < av.T.length; i++) { const dt = av.T[i] - av.T[i - 1]; if (dt <= 2 * MIN || aparcadoEntre(av, i - 1, i)) s += dt; }
  return s;
}
const enAire = e => e.al !== SUELO && !(e.al === -2 && e.gs >= 0 && e.gs < 40);
const seMueve = e => !e.aparcado && (enAire(e) || e.gs >= 5);
function hay(av, k, dir, ms, cond) {
  for (let i = k + dir; i >= 0 && i < av.T.length && Math.abs(av.T[i] - av.T[k]) <= ms; i += dir) if (cond(i)) return true;
  return false;
}
export function fase(av, e) {
  if (e.aparcado) return 'aparcado';
  const suelo = i => av.al[i] === SUELO, aire = i => av.al[i] !== SUELO && av.al[i] !== -2;
  if (enAire(e)) return hay(av, e.k, 1, 6 * MIN, suelo) ? 'aterrizando' : hay(av, e.k, -1, 6 * MIN, suelo) ? 'despegando' : 'en vuelo';
  if (e.gs >= 35) return hay(av, e.k, 1, 2 * MIN, aire) ? 'despegando' : hay(av, e.k, -1, 2 * MIN, aire) ? 'aterrizando' : 'en pista';
  return e.gs >= 3 ? 'rodando' : 'parado';
}
function indicativoEn(av, T) {
  let cs = '';
  for (const [t, c] of av.cs) { if (t <= T + 2 * MIN || !cs) cs = c; else break; }
  return cs;
}

/* ---------------- tipo, operador y matrícula parcial ---------------- */
const FAMILIAS = [
  [/^A3(18|19|20|21)$|^A(19|20|21)N$/, 'A320'], [/^BCS[13]$/, 'A220'], [/^A30[0-9B]$|^A3ST$/, 'A300'], [/^A310$/, 'A310'],
  [/^A33\d$/, 'A330'], [/^A34\d$/, 'A340'], [/^A35[0-9K]$/, 'A350'], [/^A38\d$/, 'A380'],
  [/^B73\d$|^B3[789X]M$/, 'B737'], [/^B74[0-9RSD]$/, 'B747'], [/^B75\d$/, 'B757'], [/^B76\d$/, 'B767'], [/^B77[0-9WL]$/, 'B777'], [/^B78[0-9X]$/, 'B787'],
  [/^E1[79]\d$|^E2[79]\d$|^E75[LS]$/, 'EJET'], [/^CRJ[0-9X]$/, 'CRJ'], [/^AT[4-7]\d$/, 'ATR'], [/^DH8[A-D]$/, 'DH8'], [/^MD[89]\d$|^DC9\d?$/, 'MD80'],
];
export const familia = t => { t = String(t || '').toUpperCase().trim(); for (const [re, f] of FAMILIAS) if (re.test(t)) return f; return t; };
// 2 = mismo tipo, 1 = misma familia, 0 = no se sabe, -1 = otro avión
function compatTipo(tipo, av) {
  const a = String(tipo || '').toUpperCase().trim();
  if (!a || !av.t) return 0;
  return a === av.t.toUpperCase() ? 2 : familia(a) === av.tf ? 1 : -1;
}
// Indicativo (3 letras OACI de la aerolínea) → nombre, solo para desempatar con el operador que ve la IA
const AEROLINEAS = {
  IBE: 'iberia', IBS: 'iberia express', ANE: 'air nostrum iberia regional', VLG: 'vueling', AEA: 'air europa', RYR: 'ryanair', RUK: 'ryanair',
  MAY: 'malta air ryanair', LDA: 'lauda ryanair', RYS: 'buzz ryanair', EZY: 'easyjet', EJU: 'easyjet', EZS: 'easyjet', VOE: 'volotea',
  IBB: 'binter', PLU: 'plus ultra', EVE: 'evelop', SWT: 'swiftair', BAW: 'british airways', SHT: 'british airways', EFW: 'ba euroflyer british airways',
  VIR: 'virgin atlantic', DLH: 'lufthansa', CLH: 'lufthansa cityline', EWG: 'eurowings', CFG: 'condor', AFR: 'air france', HOP: 'hop air france',
  TVF: 'transavia', TRA: 'transavia', KLM: 'klm', KLC: 'klm cityhopper', TAP: 'tap', SWR: 'swiss', EDW: 'edelweiss', AUA: 'austrian',
  BEL: 'brussels', SAS: 'sas scandinavian', FIN: 'finnair', ICE: 'icelandair', NOZ: 'norwegian', NSZ: 'norwegian', NAX: 'norwegian',
  ITY: 'ita airways', LOT: 'lot', BTI: 'airbaltic', AEE: 'aegean', TAR: 'tunisair', RAM: 'royal air maroc', DAH: 'air algerie',
  MSR: 'egyptair', ELY: 'el al', THY: 'turkish', PGT: 'pegasus', QTR: 'qatar', UAE: 'emirates', ETD: 'etihad', SVA: 'saudia',
  WZZ: 'wizz', WMT: 'wizz', WUK: 'wizz', JAF: 'tui', TOM: 'tui', TFL: 'tui', TUI: 'tui', EXS: 'jet2', AAL: 'american', UAL: 'united',
  DAL: 'delta', JBU: 'jetblue', SWA: 'southwest', ACA: 'air canada', TSC: 'air transat', AVA: 'avianca', CMP: 'copa', LAN: 'latam',
  TAM: 'latam', AMX: 'aeromexico', ARG: 'aerolineas argentinas', AZU: 'azul', GLO: 'gol', VCV: 'conviasa', ROI: 'avior',
  CCA: 'air china', CES: 'china eastern', CSN: 'china southern', FDX: 'fedex', UPS: 'ups', DHK: 'dhl', BCS: 'dhl european air transport',
  CLX: 'cargolux', GTI: 'atlas', BOX: 'aerologic',
};
const opNorm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function compatOperador(op, cs) {
  const nom = AEROLINEAS[String(cs || '').slice(0, 3).toUpperCase()], o = opNorm(op);
  if (!nom || !o || o === 'privado') return 0;
  return nom.includes(o) || o.includes(nom.split(' ')[0]) ? 1 : -1;
}
// «…XI» → termina en XI · «D-AI?I» → D,A,I,cualquiera,I · «YV30» → contiene YV30 (mínimo 3 caracteres legibles)
// (minimo = 2 solo para puntuar candidatos del ADS-B, donde ya hay pocos aviones posibles)
export function patronParcial(p, minimo = 3) {
  const raw = String(p || '').toUpperCase().trim(); if (!raw) return null;
  const suf = /^(…|\.\.\.)/.test(raw);
  const core = raw.replace(/^(…|\.\.\.)/, '').replace(/[^A-Z0-9?]/g, '');
  if (core.replace(/\?/g, '').length < (suf ? minimo : 3)) return null;
  const body = core.replace(/\?/g, '[A-Z0-9]');
  return new RegExp(suf ? body + '$' : core.includes('?') ? '^' + body + '$' : body);
}
function distancia(a, b) {   // Levenshtein (para «HB-ZOK leído, HB-ZQK real»)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/* ---------------- calibración de la hora de la cámara ---------------- */
// Matrícula «propia» de la ráfaga: escrita a mano o leída entera por la IA (no la que puso el propio ADS-B)
export function regPropia(b) {
  const reg = claveReg(b.reg);
  if (!reg) return '';
  if (b.regAdsb && claveReg(b.regAdsb) === reg && !b.touched?.reg) return '';
  return reg;
}
const horaPrincipal = b => paredDe((b.frames.find(f => f.name === b.n) || b.frames[0]).t);

export function anclas(bursts, datos) {
  const out = [];
  for (const b of bursts) {
    const reg = regPropia(b);
    if (!reg || b.ai?.hay_avion === false) continue;
    const fiable = b.touched?.reg || (claveReg(b.ai?.matricula) === reg && b.ai?.confianza !== 'baja');
    const av = fiable && datos.porReg.get(reg);
    if (av) out.push({ b, av, apt: datos.apt?.icao || '', pared: horaPrincipal(b), w: Math.max(0.05, Math.min(1, 25 * MIN / av.presente)) });
  }
  return out;
}

// Prueba desfases de −14 h a +14 h. Primero, minuto a minuto, cuáles sitúan a más aviones ancla en el aeropuerto a la
// hora de su foto; entre esos, el que los deja más juntos (un spotter fotografía siempre la misma zona, y un avión que
// aterriza recorre 4 km por minuto, así que un desfase de 1–2 min ya los separa). Con < 2 anclas útiles: sin calibrar.
// manual: desfase en minutos escrito por el usuario (se usa tal cual).
// ref: desfase que se da por bueno si cuadra igual de bien (0 = la hora de la cámara tal cual en la zona tz)
export function calibrar(an, tz, manual = null, ref = 0) {
  const utiles = an.filter(a => a.w >= 0.2);
  const base = an.map(a => paredAUtc(a.pared, tz));
  const presencia = delta => {
    let pres = 0;
    an.forEach((a, i) => { if (estadoEn(a.av, base[i] + delta * MIN)) pres += a.w; });
    return Math.round(pres * 100) / 100;
  };
  // compacidad: para cada avión en movimiento, mediana de su distancia a los otros fotografiados en ± 90 min; y la
  // mediana de todas (5 km si no hay con quién comparar)
  const evaluar = delta => {
    const pos = [];
    an.forEach((a, i) => { const e = estadoEn(a.av, base[i] + delta * MIN); if (e && seMueve(e)) pos.push({ T: e.T, lat: e.lat, lon: e.lon, i, apt: a.apt }); });
    const med = v => { v.sort((x, y) => x - y); return v[v.length >> 1]; };
    const por = pos.map(p => { const d = pos.filter(q => q !== p && Math.abs(q.T - p.T) < 90 * MIN).map(q => KM(p.lat, p.lon, q.lat, q.lon)); return d.length ? med(d) : null; }).filter(x => x != null);
    return { delta, pres: presencia(delta), disp: por.length >= 2 ? Math.min(5, med(por)) : 5, pos };
  };
  if (Number.isFinite(manual)) return { ...evaluar(manual), calibrado: true, manual: true, n: utiles.length, total: an.length };
  const cero = evaluar(ref);
  if (utiles.length < 2) return { ...cero, calibrado: false, n: utiles.length, total: an.length };
  const pres = [];
  let max = 0;
  for (let d = -840; d <= 840; d++) { const p = presencia(d); pres.push([d, p]); if (p > max) max = p; }
  const mejor = (x, y) => Math.abs(x.disp - y.disp) > 0.02 ? (x.disp < y.disp ? x : y) : x.pres !== y.pres ? (x.pres > y.pres ? x : y) : Math.abs(x.delta) <= Math.abs(y.delta) ? x : y;
  let best = null;
  for (const [d, p] of pres) if (p >= max - 0.5) { const e = evaluar(d); best = best ? mejor(best, e) : e; }
  const d0 = best.delta;
  for (let d = d0 - 1.5; d <= d0 + 1.5; d += 0.25) best = mejor(best, evaluar(d));
  // si la hora de referencia ya cuadra igual de bien, se queda esa
  if (cero.pres >= best.pres - 0.5 && cero.disp <= best.disp + 0.2) best = cero;
  const enMov = new Set(best.pos.map(p => p.i));
  an.forEach((a, i) => { a.presente = !!estadoEn(a.av, base[i] + best.delta * MIN); a.enMovimiento = enMov.has(i); });
  const nUtiles = utiles.filter(a => a.presente).length;
  return { ...best, calibrado: nUtiles >= 2, n: nUtiles, total: an.length };
}

/* ---------------- candidatos de cada ráfaga ---------------- */
const PESO_FASE = { aterrizando: 3, despegando: 3, 'en pista': 3, 'en vuelo': 2, rodando: 2, parado: 1, aparcado: 0 };

export function candidatos(b, datos, cal, tz) {
  const u = f => paredAUtc(paredDe(f.t), tz) + cal.delta * MIN;
  let A = u(b.frames[0]) - 30000, B = u(b.frames[b.frames.length - 1]) + 30000;
  if (B - A > 5 * MIN) { const t = u(b.frames.find(f => f.name === b.n) || b.frames[0]); A = t - 45000; B = t + 45000; }   // ráfagas unidas
  const medio = (A + B) / 2;
  const mismo = (cal.pos || []).filter(p => !p.apt || !datos.apt?.icao || p.apt === datos.apt.icao);
  const cerca = mismo.filter(p => Math.abs(p.T - medio) < 60 * MIN);
  const zona = cerca.length ? cerca : mismo;
  const out = [];
  for (const av of datos.aviones) {
    if (av.vehiculo || av.fin < A - 8 * 3600000 || av.ini > B + 8 * 3600000) continue;
    let m = null;
    for (let T = A; T <= B; T += 10000) {
      const e = estadoEn(av, T);
      if (!e) continue;
      e.d = zona.length ? Math.min(...zona.map(p => KM(p.lat, p.lon, e.lat, e.lon))) : null;
      if (!m || (e.d != null && e.d < m.d) || (!seMueve(m) && seMueve(e))) m = e;
    }
    if (!m) continue;
    out.push({ av, reg: av.r || av.h.toUpperCase(), tipo: av.t, cs: indicativoEn(av, m.T), fase: fase(av, m), d: m.d, T: m.T, mil: av.mil });
  }
  return out;
}

function puntuar(c, b) {
  const ai = b.ai || {};
  const tipo = ai.tipo_icao || (b.touched?.type ? b.type : '');
  const op = ai.operador || (b.touched?.op ? b.op : '');
  let s = PESO_FASE[c.fase] ?? 0;
  if (c.d != null) s += c.d < 1 ? 3 : c.d < 2.5 ? 2 : c.d < 5 ? 0 : -2;
  c.ct = compatTipo(tipo, c.av);
  s += c.ct === 2 ? 4 : c.ct === 1 ? 3 : c.ct === -1 ? -6 : 0;
  const re = patronParcial(ai.matricula_parcial, 2);
  c.parcial = re ? re.test(claveReg(c.reg)) : null;
  if (re) s += c.parcial ? 6 : -12;
  s += 1.5 * compatOperador(op, c.cs);
  c.s = s;
}

// Qué dice el ADS-B de una ráfaga
export function decidir(b, cands, datos) {
  cands.forEach(c => puntuar(c, b));
  cands.sort((x, y) => y.s - x.s || (x.d ?? 99) - (y.d ?? 99));
  const propia = regPropia(b);
  if (propia) {
    const c = cands.find(x => claveReg(x.reg) === propia);
    if (c) return { estado: 'confirmada', c };
    const parecida = cands.find(x => x.ct >= 1 && distancia(claveReg(x.reg), propia) <= 1);
    if (parecida) return { estado: 'corregir', c: parecida };
    const av = datos.porReg.get(propia);
    if (av) return { estado: 'otra_hora', av };
    return { estado: 'no_consta', top: cands.filter(x => x.ct >= 1).slice(0, 3) };
  }
  if (!cands.length) return { estado: 'nada' };
  const [a, s2] = cands;
  const seguro = a.parcial === true || a.ct === 2 || (a.ct === 1 && !['aparcado', 'parado'].includes(a.fase));
  if (seguro && a.s >= 5 && (!s2 || a.s - s2.s >= 3)) return { estado: 'propuesta', c: a };
  return { estado: 'candidatos', top: cands.filter(x => x.s >= a.s - 4 && x.ct !== -1 && x.parcial !== false).slice(0, 4) };
}

/* ---------------- v0.4.1 · qué avión pasaba por delante ---------------- */
// El avión que pasaba por delante del spotter en el instante T (UTC): el que se movía más cerca de la zona donde
// estaban, a la hora de sus fotos, los aviones ya identificados (cal.pos). null si no hay uno claro: ninguno a menos
// de 1,5 km de la zona, o dos a distancias parecidas (< 0,7 km de diferencia). Hace falta la cámara en hora.
export function delanteEn(datos, cal, T) {
  const zona = (cal.pos || []).filter(p => (!p.apt || !datos.apt?.icao || p.apt === datos.apt.icao) && Math.abs(p.T - T) < 3 * 3600000);
  if (!zona.length) return null;
  let a = null, b = null;
  for (const av of datos.aviones) {
    if (av.vehiculo || av.fin < T - 2 * MIN || av.ini > T + 2 * MIN) continue;
    const e = estadoEn(av, T);
    if (!e || !seMueve(e)) continue;
    const d = Math.min(...zona.map(p => KM(p.lat, p.lon, e.lat, e.lon)));
    if (!a || d < a.d) { b = a; a = { av, d }; } else if (!b || d < b.d) b = { av, d };
  }
  if (!a || a.d > 1.5 || (b && b.d - a.d < 0.7)) return null;
  return { reg: claveReg(a.av.r) || a.av.h.toUpperCase(), matricula: a.av.r || a.av.h.toUpperCase(), tipo: a.av.t || '', d: a.d };
}

/* ---------------- resumen para la web y para guardar ---------------- */
// Días UTC que cubren las ráfagas con este desfase (para pedir los que falten si la cámara iba en otra zona horaria)
export function fechasUtc(bursts, tz, delta) {
  const out = new Set();
  for (const b of bursts) for (const f of [b.frames[0], b.frames[b.frames.length - 1]]) {
    const u = paredAUtc(paredDe(f.t), tz) + delta * MIN;
    out.add(new Date(u - 2 * MIN).toISOString().slice(0, 10)); out.add(new Date(u + 2 * MIN).toISOString().slice(0, 10));
  }
  return [...out].sort();
}
const corto = c => ({ reg: c.reg, tipo: c.tipo || '', cs: c.cs || '', fase: c.fase, d: c.d == null ? null : Math.round(c.d * 10) / 10 });
export function resumir(r, b, tz, cal, tzMostrar = tz) {
  const out = { estado: r.estado, delta: cal.delta, calibrado: !!cal.calibrado };
  if (r.c) Object.assign(out, corto(r.c), { hora: horaAeropuerto(r.c.T, tzMostrar), por: r.c.parcial ? 'parcial' : r.c.ct === 2 ? 'tipo' : r.c.ct === 1 ? 'familia' : '' });
  if (r.top) out.top = r.top.map(corto);
  if (r.av) {   // estuvo ese día, pero no a la hora de la foto: ¿cuándo?
    const t = paredAUtc(horaPrincipal(b), tz) + cal.delta * MIN, k = Math.min(r.av.T.length - 1, indice(r.av.T, t));
    out.reg = r.av.r; out.tipo = r.av.t; out.hora = horaAeropuerto(r.av.T[k], tzMostrar);
  }
  return out;
}
