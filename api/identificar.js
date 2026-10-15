// Identificación de aviones con IA (v0.2).
// La web manda la foto elegida de una ráfaga (entera + recorte grande del avión) y, si la ráfaga es larga,
// unas tomas pequeñas más para comprobar que todo es el mismo avión. Devuelve matrícula, tipo y operador
// sugeridos, con el nivel de confianza. Las claves de la IA viven solo aquí (variables de entorno de Vercel).
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY   clave de la API de Claude (proveedor por defecto)
//   GEMINI_API_KEY      alternativa (Google Gemini), por si se quiere probar otro proveedor
//   AI_PROVIDER         "anthropic" o "gemini" (opcional; por defecto, el que tenga clave)
//   AI_MODEL            modelo (opcional; por defecto claude-sonnet-5-5 / gemini-2.5-flash)
//   AI_LIMITE_DIA       ráfagas por usuario y día (opcional; por defecto 400)

const SUPABASE_URL = 'https://vhhpbulykxiqfwarxlfu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_lXi2rPoZx8ofeM46jqwBlA_PaSQ2JSX'; // clave pública (la misma que la web)
const MAX_IMG = 900 * 1024; // bytes por imagen en base64

const ESQUEMA = {
  type: 'object',
  properties: {
    hay_avion: { type: 'boolean', description: 'false si en la foto no hay ningún avión o helicóptero reconocible' },
    matricula: { type: 'string', description: 'Matrícula o serial completo SOLO si se lee entero sin dudas; si no, cadena vacía' },
    matricula_parcial: { type: 'string', description: 'Los caracteres que sí se leen, p. ej. "D-AI?I" o "…XI" de la compuerta del tren; vacío si no se lee nada' },
    donde_se_lee: { type: 'string', description: 'fuselaje, cola, compuerta del tren delantero, ala, motor, nombre en el morro… o "no se lee"' },
    tipo_icao: { type: 'string', description: 'Designador ICAO del tipo (A20N, B738, B77W, A359, E195, C17…), vacío si no se puede saber' },
    operador: { type: 'string', description: 'Aerolínea u operador según la librea (Iberia, Ryanair, Privado, USAF…), vacío si no se sabe' },
    librea: { type: 'string', description: 'Solo si es una librea especial o retro (Retro, Star Alliance, OneWorld, SkyTeam, un aniversario…); si no, vacío' },
    confianza: { type: 'string', enum: ['alta', 'media', 'baja'], description: 'alta = matrícula legible entera y tipo seguro; media = algo deducido; baja = poco fiable' },
    varios_aviones: { type: 'boolean', description: 'true si en la foto principal hay otro avión que compite como sujeto' },
    otras_tomas: {
      type: 'array', description: 'Para cada toma adicional (en el orden recibido), si muestra el mismo avión que la principal',
      items: { type: 'object', properties: { i: { type: 'integer' }, mismo_avion: { type: 'boolean' } }, required: ['i', 'mismo_avion'], additionalProperties: false },
    },
    motivo: { type: 'string', description: 'Explicación breve en español (máx. 20 palabras): qué se lee y qué dudas hay' },
  },
  required: ['hay_avion', 'matricula', 'matricula_parcial', 'donde_se_lee', 'tipo_icao', 'operador', 'librea', 'confianza', 'varios_aviones', 'otras_tomas', 'motivo'],
  additionalProperties: false,
};

function instrucciones({ aeropuerto, fecha, nExtra }) {
  return [
    'Eres un spotter experto en identificar aeronaves en fotos. Te paso la foto elegida de una ráfaga:',
    'la imagen 1 es la foto entera y la imagen 2 un recorte ampliado del avión para leer la matrícula.',
    nExtra ? `Las imágenes 3 a ${2 + nExtra} son otras tomas de la misma ráfaga (índices 0 a ${nExtra - 1} en otras_tomas): di si cada una muestra el MISMO avión que la principal (mismo tipo, librea y matrícula). En el spot se dispara sin pausa a aviones seguidos, así que puede haber otro avión.` : 'No hay tomas adicionales: devuelve otras_tomas vacío.',
    aeropuerto ? `Aeropuerto: ${aeropuerto}.` : '',
    fecha ? `Fecha: ${fecha}.` : '',
    'Reglas:',
    '- No inventes matrículas. Pon la matrícula completa solo si la lees entera o es inequívoca. Si solo lees una parte, déjala en matricula_parcial con "?" en los caracteres dudosos y matricula vacía.',
    '- Mira también la compuerta del tren delantero: muchas aerolíneas pintan ahí las últimas 2-3 letras (p. ej. "XI" → D-AIXI). Iberia no las lleva, pero pinta el nombre del avión en el morro.',
    '- Formato de matrícula: con guion cuando lo lleva (EC-MXV, D-AIXI, 9H-ABC); EE. UU. sin guion (N123AB). Militares y gobierno: el serial tal como está pintado (08-8200, A-1102, 330002), sin punto final.',
    '- tipo_icao: el designador ICAO exacto de la variante si se distingue (A20N vs A320 por los motores y sharklets, B38M vs B738, A359 vs A35K, B77W vs B772…). Si dudas entre variantes, pon la más probable y dilo en motivo.',
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

async function conClaude(imagenes, texto, modelo) {
  const content = [];
  imagenes.forEach((b64, i) => {
    content.push({ type: 'text', text: i === 0 ? 'Imagen 1 (foto entera):' : i === 1 ? 'Imagen 2 (recorte del avión):' : `Imagen ${i + 1} (toma adicional, índice ${i - 2}):` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
  });
  content.push({ type: 'text', text: texto });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelo || 'claude-sonnet-5-5', max_tokens: 1500,
      // Salida estructurada: la respuesta sigue ESQUEMA (sustituye a la herramienta forzada, que los modelos nuevos no admiten)
      output_config: { format: { type: 'json_schema', schema: ESQUEMA } },
      messages: [{ role: 'user', content }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `Claude respondió ${r.status}`);
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let o; try { o = JSON.parse(txt); } catch { throw new Error(j.stop_reason === 'max_tokens' ? 'respuesta cortada (max_tokens)' : 'La IA no devolvió una identificación'); }
  return { ...o, _uso: j.usage };
}

async function conGemini(imagenes, texto, modelo) {
  const m = modelo || 'gemini-2.5-flash';
  const parts = [];
  imagenes.forEach((b64, i) => {
    parts.push({ text: i === 0 ? 'Imagen 1 (foto entera):' : i === 1 ? 'Imagen 2 (recorte del avión):' : `Imagen ${i + 1} (toma adicional, índice ${i - 2}):` });
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
  const reg = s(o.matricula).toUpperCase().replace(/\s+/g, '').replace(/\.$/, '');
  return {
    hay_avion: o.hay_avion !== false,
    matricula: reg,
    matricula_parcial: s(o.matricula_parcial).toUpperCase(),
    donde_se_lee: s(o.donde_se_lee),
    tipo_icao: s(o.tipo_icao).toUpperCase().replace(/\s+/g, ''),
    operador: s(o.operador),
    librea: s(o.librea),
    confianza: ['alta', 'media', 'baja'].includes(o.confianza) ? o.confianza : 'baja',
    varios_aviones: !!o.varios_aviones,
    otras_tomas: (Array.isArray(o.otras_tomas) ? o.otras_tomas : []).filter(t => Number.isInteger(t?.i) && t.i >= 0 && t.i < nExtra).map(t => ({ i: t.i, mismo_avion: t.mismo_avion !== false })),
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
  const imgs = Array.isArray(body?.imagenes) ? body.imagenes.filter(x => typeof x === 'string') : [];
  if (imgs.length < 2 || imgs.length > 6 || imgs.some(x => x.length > MAX_IMG)) return res.status(400).json({ error: 'imagenes', mensaje: 'Faltan imágenes o son demasiado grandes.' });

  const limite = +process.env.AI_LIMITE_DIA || 400;
  const uso = await controlarUso(token, limite);
  if (!uso.ok) return res.status(429).json({ error: 'limite', mensaje: `Has llegado al límite de ${limite} identificaciones por hoy. Mañana se renueva.` });

  const nExtra = imgs.length - 2;
  const texto = instrucciones({ aeropuerto: String(body.aeropuerto || '').slice(0, 4).toUpperCase(), fecha: String(body.fecha || '').slice(0, 10), nExtra });
  try {
    const crudo = proveedor === 'gemini' ? await conGemini(imgs, texto, process.env.AI_MODEL) : await conClaude(imgs, texto, process.env.AI_MODEL);
    return res.status(200).json({ ...limpiar(crudo, nExtra), proveedor, usado_hoy: uso.usado, limite });
  } catch (e) {
    console.error('identificar:', e);
    return res.status(502).json({ error: 'ia', mensaje: 'La IA no respondió: ' + String(e.message || e).slice(0, 200) });
  }
};
