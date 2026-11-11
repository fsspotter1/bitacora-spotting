// Tipos ICAO (Doc 8643): designador → «FABRICANTE Modelo» (data/tipos_icao.json, sacado de
// Mictronics/readsb-protobuf, la misma base que usan readsb y tar1090).
// Sirve para dos cosas:
//  1. Comprobar que el designador que pone la IA es el del avión que ella misma dice ver
//     (p. ej. «Cessna 408 SkyCourier» con SC7, que es el Short Skyvan → C408).
//  2. Decidir si la ficha de una matrícula cuadra con lo que se ve en la foto.
const TIPOS = require('../data/tipos_icao.json');

const VACIAS = new Set(['AIRCRAFT', 'AVIATION', 'AIRPLANE', 'AEROPLANE', 'COMPANY', 'CORPORATION', 'CORP', 'INC', 'LTD', 'LLC',
  'CO', 'INDUSTRIES', 'INTERNATIONAL', 'SERIES', 'THE', 'DE', 'DEL', 'DA', 'DO', 'LA', 'LE', 'AND', 'Y', 'AIR', 'JET', 'JETS',
  'SUPER', 'TURBOPROP', 'TURBOHELICE', 'BIMOTOR', 'TRIMOTOR', 'CUATRIMOTOR', 'HELICOPTER', 'HELICOPTERS', 'HELICOPTERO',
  'AVION', 'AVIONETA', 'MODELO', 'TIPO', 'VERSION', 'VARIANTE', 'PROBABLE', 'POSIBLE', 'PROBABLEMENTE', 'SYSTEMS']);
// Nombres del mismo fabricante (o de la misma casa a lo largo de los años)
const GRUPOS = [
  ['CESSNA', 'TEXTRON'], ['BEECH', 'BEECHCRAFT', 'TEXTRON', 'HAWKER', 'RAYTHEON'], ['BAE', 'BRITISH', 'AEROSPACE', 'HAWKER', 'SIDDELEY', 'AVRO', 'BAC'],
  ['MCDONNELL', 'DOUGLAS', 'MCDONNELLDOUGLAS', 'BOEING'], ['BOMBARDIER', 'CANADAIR', 'HAVILLAND', 'DEHAVILLAND', 'DHC', 'LEARJET'],
  ['AIRBUS', 'EUROCOPTER', 'AEROSPATIALE', 'CASA', 'EADS', 'MBB'], ['ATR', 'AEROSPATIALE', 'ALENIA'],
  ['AGUSTA', 'LEONARDO', 'AGUSTAWESTLAND', 'WESTLAND', 'AERMACCHI', 'ALENIA'], ['LOCKHEED', 'MARTIN'], ['GULFSTREAM', 'GRUMMAN'],
  ['NORTHROP', 'GRUMMAN'], ['SOCATA', 'DAHER'], ['GENERAL', 'DYNAMICS'], ['SUKHOI', 'IRKUT'], ['MIKOYAN', 'MIG'], ['BELL', 'TEXTRON'],
];
// Primera palabra de cada nombre de la tabla (CESSNA, BOEING, PIPER…) + los grupos: son fabricantes, no modelos
const FABRICANTES = new Set([...Object.values(TIPOS).map(n => n.split(' ')[0].toUpperCase()).filter(w => /^[A-Z]{3,}$/.test(w)), ...GRUPOS.flat()]);
FABRICANTES.delete('DE');

const plano = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Palabras significativas: «A-320neo» → A320NEO; los números de 2+ cifras también por separado (737-800 → 737, 800)
function palabras(s) {
  const p = plano(s);
  const w = p.replace(/[^A-Z0-9\- ]+/g, ' ').split(/\s+/).map(x => x.replace(/-/g, '')).filter(x => x.length >= 2 && !VACIAS.has(x));
  return { todas: new Set(w), numeros: new Set(p.match(/\d{2,}/g) || []) };
}
const fabricantesDe = ws => new Set([...ws].filter(x => FABRICANTES.has(x)).flatMap(x => GRUPOS.filter(g => g.includes(x)).flat().concat(x)));
const modeloDe = ws => [...ws].filter(x => !FABRICANTES.has(x) && !/^\d+$/.test(x));
// Dos palabras de modelo casan si son iguales o, con letras y 4+ caracteres, una contiene a la otra (HAWK/GOSHAWK, A320/A320NEO)
const casan = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && /[A-Z]/.test(a) && /[A-Z]/.test(b) && (a.includes(b) || b.includes(a)));

const nombreTipo = t => TIPOS[String(t || '').toUpperCase().trim()] || '';
const esTipo = t => !!nombreTipo(t);

// ¿Comparten algo propio del modelo (no solo el fabricante)? Palabras de modelo o números (737, 408, 72…)
function compartenModelo(a, b) {
  const A = palabras(a), B = palabras(b);
  if ([...A.numeros].some(n => B.numeros.has(n))) return true;
  const ma = modeloDe(A.todas), mb = modeloDe(B.todas);
  return ma.some(x => mb.some(y => casan(x, y)));
}
function mismoFabricante(a, b) {
  const fa = fabricantesDe(palabras(a).todas), fb = fabricantesDe(palabras(b).todas);
  return [...fa].some(x => fb.has(x));
}

// Designador para una descripción («Cessna 408 SkyCourier» → C408). Solo si sale UNO claramente: al menos dos
// coincidencias de modelo, o una de modelo más el fabricante. Si hay empate, no se adivina.
function buscarTipo(texto) {
  const P = palabras(texto), modelo = modeloDe(P.todas), fab = fabricantesDe(P.todas);
  if (!modelo.length && !P.numeros.size) return '';
  let mejor = [], max = 0;
  for (const [cod, nombre] of Object.entries(TIPOS)) {
    const N = palabras(nombre), mn = modeloDe(N.todas);
    // igual cuenta 1; contenida en otra (A320 en A320NEO) cuenta menos, para que gane la exacta
    let m = modelo.reduce((a, x) => a + (mn.includes(x) ? 1 : mn.some(y => casan(x, y)) ? 0.7 : 0), 0);
    m += [...P.numeros].filter(n => N.numeros.has(n)).length;
    if (!m) continue;
    const s = m + ([...fabricantesDe(N.todas)].some(x => fab.has(x)) ? 0.5 : 0);
    if (s > max) { max = s; mejor = [cod]; } else if (s === max) mejor.push(cod);
  }
  return mejor.length === 1 && max >= 1.5 ? mejor[0] : '';
}

// Familias en las que la IA suele dudar entre variantes (igual que en js/adsb.js)
const FAMILIAS = [
  [/^A3(18|19|20|21)$|^A(19|20|21)N$/, 'A320'], [/^BCS[13]$/, 'A220'], [/^A30[0-9B]$|^A3ST$/, 'A300'], [/^A310$/, 'A310'],
  [/^A33\d$/, 'A330'], [/^A34\d$/, 'A340'], [/^A35[0-9K]$/, 'A350'], [/^A38\d$/, 'A380'],
  [/^B73\d$|^B3[789X]M$/, 'B737'], [/^B74[0-9RSD]$/, 'B747'], [/^B75\d$/, 'B757'], [/^B76\d$/, 'B767'], [/^B77[0-9WL]$/, 'B777'], [/^B78[0-9X]$/, 'B787'],
  [/^E1[79]\d$|^E2[79]\d$|^E75[LS]$/, 'EJET'], [/^CRJ[0-9X]$/, 'CRJ'], [/^AT[4-7]\d$/, 'ATR'], [/^DH8[A-D]$/, 'DH8'], [/^MD[89]\d$|^DC9\d?$/, 'MD80'],
];
const familia = t => { t = String(t || '').toUpperCase().trim(); for (const [re, f] of FAMILIAS) if (re.test(t)) return f; return t; };

// Revisa el tipo que da la IA contra su propia descripción (campo aeronave). Devuelve la lectura corregida o marcada.
function revisarTipo(v) {
  const aer = String(v.aeronave || '').trim(), tipo = String(v.tipo_icao || '').toUpperCase().trim();
  if (!aer) return v;
  if (!tipo) {   // la IA sabe qué avión es pero no dio designador
    const t = buscarTipo(aer);
    return t ? { ...v, tipo_icao: t, motivo: (`Tipo ${t} deducido de «${aer}». ` + v.motivo).slice(0, 300) } : v;
  }
  const nombre = nombreTipo(tipo);
  if (!nombre) return v;   // designador que no está en la tabla (puede ser nuevo): no se toca
  if (compartenModelo(aer, nombre)) return v;
  const otro = buscarTipo(aer);
  if (otro && otro !== tipo) {
    return { ...v, tipo_icao: otro, tipo_corregido: tipo,
      motivo: (`Tipo corregido: ${tipo} es ${nombre}; «${aer}» es ${otro}. ` + v.motivo).slice(0, 300) };
  }
  if (mismoFabricante(aer, nombre)) return v;   // mismo fabricante y sin otro candidato claro (p. ej. E195-E2 = E295)
  return { ...v, tipo_dudoso: true, confianza: v.confianza === 'alta' ? 'media' : v.confianza,
    motivo: (`⚠ ${tipo} es ${nombre}, que no cuadra con «${aer}»: revisa el tipo. ` + v.motivo).slice(0, 300) };
}

// ¿La ficha de la matrícula (tipo y descripción) cuadra con lo que se ve en la foto?
function coincideConFoto(fichaTipo, fichaTexto, visto) {
  const ft = String(fichaTipo || '').toUpperCase().trim(), vt = String(visto.tipo_icao || '').toUpperCase().trim();
  const aer = String(visto.aeronave || '').trim();
  if (!vt && !aer) return true;   // la foto no dice nada que contradiga
  if (ft && vt && (ft === vt || familia(ft) === familia(vt))) return true;
  const deFicha = [nombreTipo(ft), fichaTexto].join(' '), deFoto = [aer, nombreTipo(vt)].join(' ');
  if (compartenModelo(deFicha, deFoto)) return true;
  if (ft && vt && ft.slice(0, 2) === vt.slice(0, 2) && mismoFabricante(deFicha, deFoto)) return true;   // LJ35/LJ45, BE20/BE9L…
  return false;
}

module.exports = { TIPOS, nombreTipo, esTipo, buscarTipo, revisarTipo, coincideConFoto, compartenModelo, mismoFabricante, familia };
