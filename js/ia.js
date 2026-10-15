// v0.2.2 · Identificación con IA. Prepara las imágenes de una ráfaga (foto elegida entera, recorte grande
// del avión y unas tomas pequeñas más) y las manda al servidor (/api/identificar), que es quien llama a la IA.
// Solo salen del ordenador estas imágenes reducidas; los RAW nunca.

const toB64 = blob => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = ko; r.readAsDataURL(blob); });
const toJpeg = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));

function lienzo(src, sx, sy, sw, sh, maxLado) {
  const k = Math.min(1, maxLado / Math.max(sw, sh));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
  c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

// Tomas extra para comprobar que toda la ráfaga es el mismo avión (solo en ráfagas largas): principio, medio y final.
export function tomasExtra(b) {
  const ok = b.frames.filter(f => !f.err && f.blob && f.name !== b.n);
  if (b.frames.length < 5 || !ok.length) return [];
  const idx = [0, Math.floor(ok.length / 2), ok.length - 1];
  return [...new Set(idx)].map(i => ok[i]);
}

export async function prepararImagenes(b) {
  const nF = b.frames.find(f => f.name === b.n);
  if (!nF?.blob) throw new Error('sin foto principal');
  const bmp = await createImageBitmap(nF.blob);
  const W = bmp.width, H = bmp.height;
  const entera = lienzo(bmp, 0, 0, W, H, 1024);
  // recorte del avión con margen; si no hay caja, el centro de la foto
  let [x0, y0, x1, y1] = nF.box || [0.2, 0.2, 0.8, 0.8];
  const mx = (x1 - x0) * 0.08 + 0.01, my = (y1 - y0) * 0.15 + 0.01;
  x0 = Math.max(0, x0 - mx); x1 = Math.min(1, x1 + mx); y0 = Math.max(0, y0 - my); y1 = Math.min(1, y1 + my);
  const recorte = lienzo(bmp, x0 * W, y0 * H, Math.max(16, (x1 - x0) * W), Math.max(16, (y1 - y0) * H), 1568);
  if (bmp.close) bmp.close();
  const imagenes = [await toB64(await toJpeg(entera, 0.8)), await toB64(await toJpeg(recorte, 0.88))];
  const extras = tomasExtra(b);
  for (const f of extras) {
    const e = await createImageBitmap(f.blob);
    imagenes.push(await toB64(await toJpeg(lienzo(e, 0, 0, e.width, e.height, 448), 0.75)));
    if (e.close) e.close();
  }
  return { imagenes, extras: extras.map(f => f.name) };
}

// ---------- Fichas por matrícula (v0.2.2) ----------
// Cada matrícula se busca en internet UNA vez por sesión: si varias ráfagas tienen la misma (aunque se identifiquen
// a la vez), todas esperan a la misma búsqueda. Las matrículas ya revisadas en tu bitácora no se buscan.
const fichas = new Map();   // claveReg → Promise<ficha|null>

export function fichasDeBitacora(entries) {
  for (const e of entries || []) {
    const k = claveReg(e.matricula);
    if (!k || !e.tipo || e.pendiente || fichas.has(k)) continue;
    fichas.set(k, Promise.resolve({ encontrado: true, coincide_con_foto: true, modelo: e.ia?.modelo || '', tipo_icao: e.tipo, operador: e.operador || '', fuente: '', origen: 'tu bitácora' }));
  }
}

function pedirFicha(reg, visto, { token, fecha }) {
  const k = claveReg(reg);
  if (fichas.has(k)) return { p: fichas.get(k), nueva: false };
  const p = (async () => {
    const r = await fetch('/api/identificar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ficha: { matricula: reg, tipo_icao: visto.tipo_icao, operador: visto.operador, motivo: visto.motivo }, fecha }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.mensaje || `Error ${r.status}`);
    return j?.ver || null;
  })();
  fichas.set(k, p);
  p.then(v => { if (!v) fichas.delete(k); }, () => fichas.delete(k));   // si falla, se podrá reintentar
  return { p, nueva: true };
}

// Mezcla lo visto en la foto con la ficha de la matrícula
function aplicarFicha(v, ver, deMemoria) {
  if (!ver) return v;
  const s = x => String(x ?? '').trim();
  const dominio = ver.origen || (() => { try { return new URL(s(ver.fuente)).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const memo = deMemoria && ver.origen !== 'tu bitácora' ? ' (ya buscada)' : '';
  if (!ver.encontrado) return { ...v, verificado: false, motivo: (v.motivo + ' · Matrícula sin ficha en internet' + memo + '.').slice(0, 300) };
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
    verificado_de: ver.origen === 'tu bitácora' ? 'bitacora' : deMemoria ? 'memoria' : 'internet',
    fuente: s(ver.fuente),
    confianza: v.confianza === 'baja' ? 'media' : 'alta',
    motivo: (`✓ ${s(ver.modelo) || tipo}${cambio}, según ${dominio || 'internet'}${memo}. ` + (s(ver.nota) && !deMemoria ? s(ver.nota) + ' ' : '') + '· ' + v.motivo).slice(0, 300),
  };
}

export async function identificar(b, { token, aeropuerto, fecha }) {
  const { imagenes, extras } = await prepararImagenes(b);
  const r = await fetch('/api/identificar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ imagenes, aeropuerto, fecha, verificar: false }),
  });
  let j = null; try { j = await r.json(); } catch { /* respuesta vacía */ }
  if (!r.ok) { const e = new Error(j?.mensaje || `Error ${r.status}`); e.code = j?.error || String(r.status); throw e; }
  // nombres de archivo de las tomas que la IA ve como otro avión
  j.otro_avion_en = (j.otras_tomas || []).filter(t => !t.mismo_avion).map(t => extras[t.i]).filter(Boolean);
  j.para = b.n;   // foto con la que se identificó
  // Ficha de la matrícula: de tu bitácora, de una búsqueda anterior de esta sesión o, si es nueva, de internet
  if (j.hay_avion && /^[A-Z0-9-]{3,10}$/.test(j.matricula || '')) {
    try {
      const { p, nueva } = pedirFicha(j.matricula, j, { token, fecha });
      return aplicarFicha(j, await p, !nueva);
    } catch { /* sin ficha: se queda lo visto en la foto */ }
  }
  return j;
}

// Clave para comparar matrículas: sin guiones, espacios ni librea entre paréntesis
export const claveReg = r => String(r || '').replace(/\(.*?\)/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
