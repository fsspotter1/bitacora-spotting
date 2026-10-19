// Identificación de aviones con IA (v0.3).
// La web manda la foto elegida de una ráfaga (entera + recorte grande del avión) y, si la ráfaga es larga,
// unas tomas pequeñas más para comprobar que todo es el mismo avión. Devuelve matrícula, tipo y operador
// sugeridos, con el nivel de confianza. Las claves de la IA viven solo aquí (variables de entorno de Vercel).
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY   clave de la API de Claude (proveedor por defecto)
//   GEMINI_API_KEY      alternativa (Google Gemini), por si se quiere probar otro proveedor
//   AI_PROVIDER         "anthropic" o "gemini" (opcional; por defecto, el que tenga clave)
//   AI_MODEL_LECTURA    modelo que lee la foto (opcional; por defecto claude-haiku-5-5, el barato)
//   AI_MODEL_REVISION   modelo que repasa las lecturas dudosas (opcional; por defecto claude-sonnet-5-5;
//                       AI_MODEL, si existe, hace lo mismo por compatibilidad). AI_REVISION=0 la desactiva.
//   (Gemini: AI_MODEL, por defecto gemini-2.5-flash)
//   AI_LIMITE_DIA       ráfagas por usuario y día (opcional; por defecto 400)

const SUPABASE_URL = 'https://vhhpbulykxiqfwarxlfu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_lXi2rPoZx8ofeM46jqwBlA_PaSQ2JSX'; // clave pública (la misma que la web)
const MAX_IMG = 900 * 1024; // bytes por imagen en base64

const ESQUEMA = {
  type: 'object',
  properties: {
    hay_avion: { type: 'boolean', description: 'false si en la foto no hay ningún avión o helicóptero reconocible' },
    matricula: { type: 'string', description: 'Matrícula civil o serial militar oficial completo SOLO si se lee entero sin dudas; nunca el código de unidad; si no, cadena vacía' },
    codigo: { type: 'string', description: 'Solo militares: código o indicativo de unidad pintado en grande (p. ej. 15-30 en el morro de un F-18 español, 31-21, 4-12, 118-AT); vacío si no hay' },
    matricula_parcial: { type: 'string', description: 'Los caracteres que sí se leen, p. ej. "D-AI?I" o "…XI" de la compuerta del tren; vacío si no se lee nada' },
    donde_se_lee: { type: 'string', description: 'fuselaje, cola, compuerta del tren delantero, ala, motor, nombre en el morro… o "no se lee"' },
    tipo_icao: { type: 'string', description: 'Designador ICAO del tipo (A20N, B738, B77W, A359, E195, C17…), vacío si no se puede saber' },
    operador: { type: 'string', description: 'Aerolínea u operador según la librea (Iberia, Ryanair, Privado, USAF…), vacío si no se sabe' },
    librea: { type: 'string', description: 'Solo si es una librea especial o retro (Retro, Star Alliance, OneWorld, SkyTeam, un aniversario…); si no, vacío' },
    confianza: { type: 'string', enum: ['alta', 'media', 'baja'], description: 'alta = matrícula legible entera y tipo seguro; media = algo deducido; baja = poco fiable' },
    varios_aviones: { type: 'boolean', description: 'true si en la foto principal hay otro avión que compite como sujeto' },
    avion_entero: { type: 'boolean', description: 'Imagen 1: true si el avión cabe ENTERO en el encuadre (morro, cola, puntas de ala y estabilizadores dentro), aunque roce el borde; false solo si alguna parte del avión sale de la foto' },
    otras_tomas: {
      type: 'array', description: 'Para cada toma adicional (en el orden recibido), si muestra el mismo avión que la principal y si sale entero',
      items: { type: 'object', properties: { i: { type: 'integer' }, mismo_avion: { type: 'boolean' }, entero: { type: 'boolean', description: 'true si el avión cabe entero en esa toma' } }, required: ['i', 'mismo_avion', 'entero'], additionalProperties: false },
    },
    motivo: { type: 'string', description: 'Explicación breve en español (máx. 20 palabras): qué se lee y qué dudas hay' },
  },
  required: ['hay_avion', 'matricula', 'matricula_parcial', 'donde_se_lee', 'codigo', 'tipo_icao', 'operador', 'librea', 'confianza', 'varios_aviones', 'avion_entero', 'otras_tomas', 'motivo'],
  additionalProperties: false,
};

// Qué es cada imagen: 1 foto entera, luego los recortes del avión (el de la principal y, si hay, el de otra toma
// del mismo avión a resolución completa) y al final las tomas adicionales pequeñas de la ráfaga.
function etiquetas(n, nRecortes) {
  return Array.from({ length: n }, (_, i) => i === 0 ? 'Imagen 1 (foto entera):'
    : i === 1 ? 'Imagen 2 (recorte del avión de la foto principal):'
    : i <= nRecortes ? `Imagen ${i + 1} (recorte del mismo avión en otra toma, a resolución completa):`
    : `Imagen ${i + 1} (toma adicional, índice ${i - 1 - nRecortes}):`);
}

function instrucciones({ aeropuerto, fecha, nExtra, nRecortes = 1 }) {
  const primeraExtra = 2 + nRecortes;
  return [
    'Eres un spotter experto en identificar aeronaves en fotos. Te paso la foto elegida de una ráfaga:',
    'la imagen 1 es la foto entera y la imagen 2 un recorte ampliado del avión para leer la matrícula.',
    nRecortes > 1 ? `${nRecortes > 2 ? `Las imágenes 3 a ${1 + nRecortes} son recortes` : 'La imagen 3 es un recorte'} del mismo avión en otra toma, a resolución completa: úsalo también para leer la matrícula (lo que tapa el ala, el motor o un reflejo en una toma suele verse en otra). Si alguno no es el mismo avión, ignóralo.` : '',
    nExtra ? `${nExtra > 1 ? `Las imágenes ${primeraExtra} a ${primeraExtra + nExtra - 1} son` : `La imagen ${primeraExtra} es`} otras tomas pequeñas de la misma ráfaga (índices 0 a ${nExtra - 1} en otras_tomas): di si cada una muestra el MISMO avión que la principal (mismo tipo, librea y matrícula) y si el avión sale entero. En el spot se dispara sin pausa a aviones seguidos, así que puede haber otro avión.` : 'No hay tomas adicionales: devuelve otras_tomas vacío.',
    aeropuerto ? `Aeropuerto: ${aeropuerto}.` : '',
    fecha ? `Fecha: ${fecha}.` : '',
    'Reglas:',
    '- No inventes matrículas. Pon la matrícula completa solo si la lees entera o es inequívoca. Si solo lees una parte, déjala en matricula_parcial con "?" en los caracteres dudosos y matricula vacía.',
    '- La matrícula suele ir pequeña en el fuselaje trasero, junto a la cola, o en la deriva: búscala ahí con calma en el recorte antes de darla por ilegible. Si la lees entera en CUALQUIERA de los recortes, ponla completa aunque en la foto principal quede tapada.',
    '- avion_entero: mira los cuatro bordes de la imagen 1. Un avión que llena la foto de lado a lado con el morro o la cola a pocos píxeles del borde SIGUE entero; solo es false si de verdad falta un trozo (morro, cola, punta de ala o estabilizador fuera de la foto).',
    '- Mira también la compuerta del tren delantero: muchas aerolíneas pintan ahí las últimas 2-3 letras (p. ej. "XI" → D-AIXI). Iberia no las lleva, pero pinta el nombre del avión en el morro.',
    '- Formato de matrícula: con guion cuando lo lleva (EC-MXV, D-AIXI, 9H-ABC); EE. UU. sin guion (N123AB). Militares y gobierno: el serial oficial tal como está pintado (08-8200, A-1102, 330002, C.15-72, T.22-1), sin punto final.',
    '- Militares: NO confundas el serial con el código de unidad. El número grande del morro o la deriva suele ser el código de unidad (España: 15-30, 12-50, 31-21 = ala/escuadrón + número; Italia: 4-12; Francia: 118-AT) y va en "codigo". El serial oficial suele ir pequeño en la deriva o el fuselaje trasero (España: C.15-72, T.21-03; Italia: MM7062; Francia: el número de construcción). Si el serial no se lee, matricula vacía y confianza baja, aunque el código se lea perfectamente.',
    '- tipo_icao: el designador ICAO exacto de la variante solo si se distingue claramente (cuenta ventanillas, motores, winglets…) (A20N vs A320 por los motores y sharklets, B38M vs B738, A359 vs A35K, B77W vs B772…). Si dudas entre variantes, pon la más probable y dilo en motivo.',
    '- operador: el nombre comercial habitual (Iberia, Air Europa, Lufthansa, easyJet, Ryanair, Qatar Airways…). Aviones privados o ejecutivos sin aerolínea: "Privado".',
    '- confianza "baja" si la foto es nocturna, de frente, de cola, el avión está lejos o tapado, o si la matrícula no se lee.',
    'Responde solo con el JSON pedido.',
  ].filter(Boolean).join('\n');
}

async function usuario(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return r.json();
}

// Cuenta y registra el uso del día con la sesión del propio usuario (las reglas de la tabla solo le dejan ver lo suyo).
async function controlarUso(token, limite) {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` };
  const hoy = new Date(); hoy.setUTCHours(0, 0, 0, 0);
  try {
    const c = await fetch(`${SUPABASE_URL}/rest/v1/ai_uso?select=id&created_at=gte.${hoy.toISOString()}`, { headers: { ...h, Prefer: 'count=exact', Range: '0-0' } });
    if (!c.ok) return { ok: true, usado: null }; // tabla aún no creada: no bloquear la beta
    const total = +((c.headers.get('content-range') || '').split('/')[1] || 0);
    if (total >= limite) return { ok: false, usado: total };
    await fetch(`${SUPABASE_URL}/rest/v1/ai_uso`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: '{}' });
    return { ok: true, usado: total + 1 };
  } catch { return { ok: true, usado: null }; }
}

const MODELO_LECTURA = () => process.env.AI_MODEL_LECTURA || 'claude-haiku-5-5';
const MODELO_REVISION = () => process.env.AI_MODEL_REVISION || process.env.AI_MODEL || 'claude-sonnet-5-5';
const corto = m => /haiku/i.test(m) ? 'Haiku' : /sonnet/i.test(m) ? 'Sonnet' : /opus/i.test(m) ? 'Opus' : m;

// Lectura dudosa = se repasa con el modelo grande: no ve avión, confianza no alta o solo parte de la matrícula
const dudosa = o => !o || o.hay_avion === false || o.confianza !== 'alta' || (!String(o.matricula || '').trim() && !!String(o.matricula_parcial || '').trim())
  || (!!String(o.codigo || '').trim() && String(o.codigo).trim().toUpperCase() === String(o.matricula || '').trim().toUpperCase());

// Lee la foto con el modelo barato y, si la lectura es dudosa (o el modelo falla), la repite con el grande.
async function leerConClaude(imagenes, texto) {
  const barato = MODELO_LECTURA(), grande = MODELO_REVISION();
  let o = null, fallo = null;
  try { o = await conClaude(imagenes, texto, barato); } catch (e) { fallo = e; }
  if (barato === grande || process.env.AI_REVISION === '0') {
    if (!o) throw fallo;
    return { ...o, _modelo: corto(barato), _revisado: false };
  }
  if (o && !dudosa(o)) return { ...o, _modelo: corto(barato), _revisado: false };
  try {
    const r = await conClaude(imagenes, texto, grande);
    return { ...r, _modelo: corto(grande), _revisado: true, _motivo_revision: o ? 'lectura dudosa' : 'falló ' + corto(barato) };
  } catch (e) {
    if (o) return { ...o, _modelo: corto(barato), _revisado: false };   // sin revisión posible: mejor la lectura barata que nada
    throw e;
  }
}

// Modo prueba: los dos modelos leen la misma foto; se devuelve la lectura del grande y la comparación
async function compararModelos(imagenes, texto) {
  const barato = MODELO_LECTURA(), grande = MODELO_REVISION();
  const [a, b] = await Promise.allSettled([conClaude(imagenes, texto, barato), conClaude(imagenes, texto, grande)]);
  if (b.status !== 'fulfilled') throw b.reason;
  const resumen = x => x.status === 'fulfilled'
    ? { matricula: String(x.value.matricula || ''), matricula_parcial: String(x.value.matricula_parcial || ''), tipo_icao: String(x.value.tipo_icao || ''), operador: String(x.value.operador || ''), confianza: String(x.value.confianza || ''), hay_avion: x.value.hay_avion !== false, revisaria: dudosa(x.value) }
    : { error: String(x.reason?.message || x.reason).slice(0, 120) };
  return { ...b.value, _modelo: corto(grande), _revisado: false, _comparacion: { [corto(barato).toLowerCase()]: resumen(a), [corto(grande).toLowerCase()]: resumen(b), barato: corto(barato), grande: corto(grande) } };
}

async function conClaude(imagenes, texto, modelo) {
  const content = [];
  imagenes.forEach((b64, i) => {
    content.push({ type: 'text', text: imagenes.etiquetas?.[i] || `Imagen ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
  });
  content.push({ type: 'text', text: texto });
  const j = await llamarClaude({
      model: modelo || 'claude-sonnet-5-5', max_tokens: 1500,
      // Salida estructurada: la respuesta sigue ESQUEMA (sustituye a la herramienta forzada, que los modelos nuevos no admiten)
      output_config: { format: { type: 'json_schema', schema: ESQUEMA } },
      messages: [{ role: 'user', content }],
  });
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let o; try { o = JSON.parse(txt); } catch { throw new Error(j.stop_reason === 'max_tokens' ? 'respuesta cortada (max_tokens)' : 'La IA no devolvió una identificación'); }
  return { ...o, _uso: j.usage };
}

// ---------- v0.2.1 · verificación de la matrícula en internet ----------
// Con la matrícula leída en la foto, Claude abre las fichas de esa matrícula en JetPhotos, airport-data y
// Planespotters (solo esas webs) y corrige tipo y operador. No hay cargo extra por consulta: solo los tokens leídos.
const WEBS_VERIF = ['jetphotos.com', 'www.jetphotos.com', 'airport-data.com', 'www.airport-data.com', 'planespotters.net', 'www.planespotters.net'];

function urlsMatricula(reg) {
  const r = encodeURIComponent(reg);
  return [
    `https://www.jetphotos.com/registration/${r}`,
    `https://www.airport-data.com/aircraft/${r}.html`,
    `https://www.planespotters.net/search?q=${r}`,
  ];
}

function textoVerificacion(reg, visto, fecha) {
  return [
    `Eres un spotter experto. En una foto${fecha ? ` del ${fecha}` : ''} se ha leído la matrícula ${reg}.`,
    `Lo que se ve en la foto (puede estar mal en el tipo exacto): tipo ${visto.tipo_icao || '?'}, operador ${visto.operador || '?'}. Descripción: ${visto.motivo || '—'}`,
    'Consulta estas fichas de la matrícula (ábrelas con web_fetch; si una falla, sigue con las demás):',
    ...urlsMatricula(reg).map(u => '- ' + u),
    'Con lo que digan las fichas, devuelve SOLO un objeto JSON (sin texto antes ni después) con estos campos:',
    '{"encontrado": bool, "modelo": "fabricante y modelo exactos según la ficha, p. ej. Beechcraft B200GT King Air 250",',
    ' "tipo_icao": "designador ICAO de ese modelo (p. ej. BE20, B350, LJ35, LJ45, SW2, PAY2, C25B, A20N, B738)",',
    ' "operador": "operador en la fecha de la foto (o el más cercano); \\"Privado\\" si es privado; vacío si no consta",',
    ' "coincide_con_foto": bool (false si la ficha describe un avión claramente distinto del de la foto: otra familia, otro número de motores…),',
    ' "fuente": "URL de la ficha más útil", "nota": "máx. 15 palabras en español"}',
    'Reglas: usa solo lo que pone en las fichas; no inventes. Si ninguna ficha tiene datos de esta matrícula, encontrado=false y el resto vacío.',
    'Ojo: una matrícula puede haberse reutilizado en otro avión con los años; elige el que estuviera registrado en la fecha de la foto.',
  ].join('\n');
}

// Con saturación (429 límite de ritmo, 529 sobrecarga) espera y reintenta, en vez de rendirse a la primera
async function llamarClaude(cuerpo) {
  for (let intento = 0; ; intento++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    const j = await r.json().catch(() => null);
    if (r.ok) return j;
    if ((r.status === 429 || r.status === 529 || r.status >= 500) && intento < 4) {
      const espera = Math.min(20, +(r.headers.get('retry-after') || 0) || 3 * 2 ** intento) * 1000;
      await new Promise(ok => setTimeout(ok, espera + Math.random() * 1000));
      continue;
    }
    const e = new Error(j?.error?.message || `Claude respondió ${r.status}`); e.status = r.status; throw e;
  }
}

async function verificarMatricula(reg, visto, fecha) {
  const modelos = [...new Set([process.env.AI_MODEL_VERIF || 'claude-haiku-5-5', process.env.AI_MODEL || 'claude-sonnet-5-5'])];
  let ultimoError;
  for (const model of modelos) {   // si el modelo barato no admite la herramienta, se prueba con el principal
    try {
      const messages = [{ role: 'user', content: textoVerificacion(reg, visto, fecha) }];
      let j;
      for (let vuelta = 0; vuelta < 4; vuelta++) {
        j = await llamarClaude({
          model, max_tokens: 1200, messages,
          tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3, allowed_domains: WEBS_VERIF, max_content_tokens: 6000 }],
        });
        if (j.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: j.content });   // turno largo: se continúa tal cual
      }
      const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const o = JSON.parse(m[0]);
      return { ...o, _uso: j.usage, _modelo: model };
    } catch (e) {
      ultimoError = e;
      if (e.status !== 400) break;   // solo se reintenta con otro modelo si la petición no era válida para este
    }
  }
  console.error('verificar:', ultimoError);
  return null;
}

// Mezcla lo visto en la foto con lo que dicen las fichas
function aplicarVerificacion(v, ver) {
  if (!ver) return v;
  const s = x => String(x ?? '').trim();
  const dominio = (() => { try { return new URL(s(ver.fuente)).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  if (!ver.encontrado) return { ...v, verificado: false, motivo: (v.motivo + ' · Matrícula sin ficha en internet.').slice(0, 300) };
  if (ver.coincide_con_foto === false) {
    return { ...v, verificado: false, confianza: 'baja', fuente: s(ver.fuente),
      motivo: (`⚠ La ficha de ${v.matricula} dice ${s(ver.modelo)}, que no cuadra con la foto: revisa la matrícula. ` + v.motivo).slice(0, 300) };
  }
  const tipo = s(ver.tipo_icao).toUpperCase().replace(/\s+/g, '');
  const cambio = tipo && tipo !== v.tipo_icao ? ` (la IA había dicho ${v.tipo_icao || '?'})` : '';
  return {
    ...v,
    tipo_icao: tipo || v.tipo_icao,
    operador: s(ver.operador) || v.operador,
    modelo: s(ver.modelo),
    verificado: true,
    fuente: s(ver.fuente),
    confianza: v.confianza === 'baja' ? 'media' : 'alta',
    motivo: (`✓ ${s(ver.modelo) || tipo}${cambio}, según ${dominio || 'internet'}. ` + (s(ver.nota) ? s(ver.nota) + ' ' : '') + '· ' + v.motivo).slice(0, 300),
  };
}

async function conGemini(imagenes, texto, modelo) {
  const m = modelo || 'gemini-2.5-flash';
  const parts = [];
  imagenes.forEach((b64, i) => {
    parts.push({ text: imagenes.etiquetas?.[i] || `Imagen ${i + 1}:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
  });
  parts.push({ text: texto.replace('Responde solo con el JSON pedido.', 'Responde solo con el JSON pedido.') });
  const schema = JSON.parse(JSON.stringify(ESQUEMA), (k, v) => (k === 'additionalProperties' ? undefined : v));
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `Gemini respondió ${r.status}`);
  const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  return { ...JSON.parse(txt), _uso: j.usageMetadata };
}

function limpiar(o, nExtra) {
  const s = v => String(v ?? '').trim();
  let reg = s(o.matricula).toUpperCase().replace(/\s+/g, '').replace(/\.$/, '');
  if (reg && reg === s(o.codigo).toUpperCase().replace(/\s+/g, '')) reg = '';   // el código de unidad no es la matrícula
  return {
    hay_avion: o.hay_avion !== false,
    matricula: reg,
    matricula_parcial: s(o.matricula_parcial).toUpperCase(),
    donde_se_lee: s(o.donde_se_lee),
    codigo: s(o.codigo).toUpperCase(),
    tipo_icao: s(o.tipo_icao).toUpperCase().replace(/\s+/g, ''),
    operador: s(o.operador),
    librea: s(o.librea),
    confianza: ['alta', 'media', 'baja'].includes(o.confianza) ? o.confianza : 'baja',
    varios_aviones: !!o.varios_aviones,
    avion_entero: typeof o.avion_entero === 'boolean' ? o.avion_entero : null,
    otras_tomas: (Array.isArray(o.otras_tomas) ? o.otras_tomas : []).filter(t => Number.isInteger(t?.i) && t.i >= 0 && t.i < nExtra)
      .map(t => ({ i: t.i, mismo_avion: t.mismo_avion !== false, entero: typeof t.entero === 'boolean' ? t.entero : null })),
    motivo: s(o.motivo).slice(0, 300),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Usa POST' }); }
  const proveedor = process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.GEMINI_API_KEY ? 'gemini' : '');
  if (!proveedor || (proveedor === 'anthropic' && !process.env.ANTHROPIC_API_KEY) || (proveedor === 'gemini' && !process.env.GEMINI_API_KEY)) {
    return res.status(503).json({ error: 'sin_clave', mensaje: 'La identificación con IA aún no está activada en el servidor.' });
  }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const u = token && await usuario(token).catch(() => null);
  if (!u?.id) return res.status(401).json({ error: 'sin_sesion', mensaje: 'Vuelve a entrar en la web.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }

  // Modo ficha: la web ya tiene la matrícula leída y solo pide sus datos en internet (una vez por matrícula y sesión).
  if (body?.ficha) {
    const f = body.ficha, reg = String(f.matricula || '').toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9.-]{3,12}$/.test(reg)) return res.status(400).json({ error: 'matricula', mensaje: 'Matrícula no válida.' });
    if (proveedor !== 'anthropic' && !process.env.ANTHROPIC_API_KEY) return res.status(200).json({ ver: null });
    if (process.env.AI_VERIFICAR === '0') return res.status(200).json({ ver: null });
    const visto = { tipo_icao: String(f.tipo_icao || '').slice(0, 8), operador: String(f.operador || '').slice(0, 60), motivo: String(f.motivo || '').slice(0, 300) };
    const ver = await verificarMatricula(reg, visto, String(body.fecha || '').slice(0, 10));
    if (!ver) return res.status(200).json({ ver: null });
    const s = x => String(x ?? '').trim().slice(0, 200);
    return res.status(200).json({ ver: { encontrado: !!ver.encontrado, coincide_con_foto: ver.coincide_con_foto !== false, modelo: s(ver.modelo),
      tipo_icao: s(ver.tipo_icao).toUpperCase().replace(/\s+/g, ''), operador: s(ver.operador), fuente: s(ver.fuente), nota: s(ver.nota) } });
  }

  const imgs = Array.isArray(body?.imagenes) ? body.imagenes.filter(x => typeof x === 'string') : [];
  if (imgs.length < 2 || imgs.length > 7 || imgs.some(x => x.length > MAX_IMG)) return res.status(400).json({ error: 'imagenes', mensaje: 'Faltan imágenes o son demasiado grandes.' });

  // Límite diario por usuario (protege el saldo frente a los beta testers). AI_LIMITE_DIA=0 lo quita para todos;
  // AI_SIN_LIMITE = correos separados por comas que no tienen límite (p. ej. el administrador haciendo pruebas).
  const sinLimite = String(process.env.AI_SIN_LIMITE || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  const limiteEnv = process.env.AI_LIMITE_DIA;
  const limite = (limiteEnv === '0' || sinLimite.includes(String(u.email || '').toLowerCase())) ? Infinity : (+limiteEnv || 400);
  const uso = await controlarUso(token, limite);
  if (!uso.ok) return res.status(429).json({ error: 'limite', mensaje: `Has llegado al límite de ${limite} identificaciones por hoy. Mañana se renueva.` });

  // nRecortes: recortes del avión a resolución completa (principal + otras tomas); los clientes antiguos mandan 1
  const nRecortes = Math.max(1, Math.min(3, imgs.length - 1, Number.isInteger(body.nRecortes) ? body.nRecortes : 1));
  const nExtra = imgs.length - 1 - nRecortes;
  imgs.etiquetas = etiquetas(imgs.length, nRecortes);
  const texto = instrucciones({ aeropuerto: String(body.aeropuerto || '').slice(0, 4).toUpperCase(), fecha: String(body.fecha || '').slice(0, 10), nExtra, nRecortes });
  try {
    const crudo = proveedor === 'gemini' ? await conGemini(imgs, texto, process.env.AI_MODEL)
      : body.comparar === true ? await compararModelos(imgs, texto)
      : await leerConClaude(imgs, texto);
    let v = { ...limpiar(crudo, nExtra), modelo: crudo._modelo || 'Gemini', revisado: !!crudo._revisado };
    if (crudo._comparacion) v.comparacion = crudo._comparacion;
    // Verificación en línea solo para clientes antiguos; la web actual manda verificar:false y pide la ficha aparte.
    if (body.verificar !== false && process.env.ANTHROPIC_API_KEY && process.env.AI_VERIFICAR !== '0' && v.hay_avion && /^[A-Z0-9.-]{3,12}$/.test(v.matricula)) {
      v = aplicarVerificacion(v, await verificarMatricula(v.matricula, v, String(body.fecha || '').slice(0, 10)));
    }
    return res.status(200).json({ ...v, proveedor, usado_hoy: uso.usado, limite });
  } catch (e) {
    console.error('identificar:', e);
    return res.status(502).json({ error: 'ia', mensaje: 'La IA no respondió: ' + String(e.message || e).slice(0, 200) });
  }
};
