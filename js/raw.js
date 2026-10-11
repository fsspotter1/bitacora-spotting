// Lectura local de RAW: vista previa JPEG embebida + hora de captura. Nada sale del ordenador.
import { detect, embed } from './detect.js';
export const RAW_RE = /\.(nef|nrw|cr2|cr3|arw|dng|raf|orf|rw2|pef|jpe?g)$/i;

function parseTiff(buf) {
  const dv = new DataView(buf); const out = { previews: [], date: null };
  if (dv.byteLength < 8) return out;
  const bo = dv.getUint16(0); const le = bo === 0x4949; if (!le && bo !== 0x4d4d) return out;
  const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const seen = new Set();
  const ifd = (off, depth) => {
    if (depth > 6 || seen.has(off) || off <= 0 || off + 2 > dv.byteLength) return; seen.add(off);
    const n = u16(off); if (n > 600) return;
    let jo = null, jl = null; const subs = [];
    for (let i = 0; i < n; i++) {
      const p = off + 2 + i * 12; if (p + 12 > dv.byteLength) return;
      const tag = u16(p), typ = u16(p + 2), cnt = u32(p + 4), v32 = u32(p + 8), v = typ === 3 ? u16(p + 8) : v32;
      if (tag === 0x201) jo = v; else if (tag === 0x202) jl = v;
      else if (tag === 0x14a) { if (cnt === 1) subs.push(v32); else for (let k = 0; k < Math.min(cnt, 8); k++) { const q = v32 + 4 * k; if (q + 4 <= dv.byteLength) subs.push(u32(q)); } }
      else if (tag === 0x8769) subs.push(v32);
      else if ((tag === 0x9003 || (tag === 0x132 && !out.date)) && typ === 2 && cnt >= 19 && v32 + 19 <= dv.byteLength) {
        let s = ''; for (let k = 0; k < 19; k++) s += String.fromCharCode(dv.getUint8(v32 + k));
        if (/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(s)) out.date = s;
      }
    }
    if (jo && jl) out.previews.push({ off: jo, len: jl });
    subs.forEach(s => ifd(s, depth + 1));
    const np = off + 2 + n * 12; if (np + 4 <= dv.byteLength) { const nx = u32(np); if (nx) ifd(nx, depth + 1); }
  };
  ifd(u32(4), 0);
  return out;
}

function scanJpegs(buf) {
  const a = new Uint8Array(buf), out = [];
  for (let i = 0; i < a.length - 3; i++) {
    if (a[i] === 0xFF && a[i + 1] === 0xD8 && a[i + 2] === 0xFF) {
      for (let j = i + 2000; j < a.length - 1; j++) if (a[j] === 0xFF && a[j + 1] === 0xD9) { out.push({ off: i, len: j + 2 - i }); i = j; break; }
    }
  }
  return out;
}

export async function readFrame(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return { blob: file, date: null };
  const head = await file.slice(0, 1 << 20).arrayBuffer();
  if (ext === 'raf') { const dv = new DataView(head); const jo = dv.getUint32(84), jl = dv.getUint32(88); return { blob: file.slice(jo, jo + jl, 'image/jpeg'), date: null }; }
  const t = parseTiff(head);
  let cands = t.previews.filter(p => p.len > 20000 && p.off + p.len <= file.size);
  if (!cands.length) { const more = await file.slice(0, Math.min(file.size, 6 << 20)).arrayBuffer(); cands = scanJpegs(more).filter(p => p.len > 20000); }
  cands.sort((a, b) => b.len - a.len);
  for (const c of cands) {
    const blob = file.slice(c.off, c.off + c.len, 'image/jpeg');
    const sig = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (sig[0] === 0xFF && sig[1] === 0xD8) return { blob, date: t.date };
  }
  throw new Error('sin vista previa');
}

export function captureTime(exifDate, file) {
  if (exifDate) { const [d, h] = exifDate.split(' '); const [Y, M, D] = d.split(':').map(Number); const [hh, mm, ss] = h.split(':').map(Number); return new Date(Y, M - 1, D, hh, mm, ss).getTime(); }
  return file.lastModified;
}

const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));

// Analiza una toma: dónde está el avión (detector; si no carga, bordes), nitidez dentro de él,
// si toca el borde del encuadre (cortado) y si algo se cruza por delante (poste, valla, persona,
// vehículo u otro avión más cerca). Devuelve miniaturas.
export async function analyse(blob) {
  const bmp = await createImageBitmap(blob);
  const W = 720, H = Math.round(bmp.height * W / bmp.width);
  const mk = w => { const k = document.createElement('canvas'); k.width = w; k.height = Math.round(bmp.height * w / bmp.width); k.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, k.width, k.height); return k; };
  const c = mk(W), det = mk(640), small = mk(320), big = mk(1600), keep = mk(480);
  const px = c.getContext('2d').getImageData(0, 0, W, H).data, gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  let x0, x1, y0, y1, obst = 0, found = false, touches;
  const dets = await detect(det).catch(() => null);
  if (!dets) found = null;   // detector no disponible
  if (dets) {
    const planes = dets.filter(d => d.cls === 5).sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]));
    if (planes.length) {
      found = true; const [bx0, by0, bx1, by1] = planes[0].box;
      x0 = Math.round(bx0 * W); x1 = Math.round(bx1 * W); y0 = Math.round(by0 * H); y1 = Math.round(by1 * H);
      const mg = 0.015; touches = (bx0 < mg) + (bx1 > 1 - mg) + (by0 < mg) + (by1 > 1 - mg);
      // personas, vehículos u otro avión más cerca (más abajo en la foto) encima del avión
      const area = (bx1 - bx0) * (by1 - by0);
      for (const d of dets) {
        if (d === planes[0] || ![1, 3, 4, 5, 6, 8].includes(d.cls)) continue;
        const [a0, b0, a1, b1] = d.box, ov = Math.max(0, Math.min(bx1, a1) - Math.max(bx0, a0)) * Math.max(0, Math.min(by1, b1) - Math.max(by0, b0)) / area;
        if (b1 >= by1 - 0.05 && ov > (d.cls === 5 ? 0.1 : 0.01)) obst = 1;
      }
    }
  }
  if (!found) {   // sin detector: caja aproximada por bordes
    const grad = new Float32Array(W * H), vals = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; const v = Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + W] - gray[i - W]); grad[i] = v; if ((x + y) % 4 === 0) vals.push(v); }
    vals.sort((a, b) => a - b); const thr = vals[Math.floor(vals.length * 0.95)] || 0;
    const colS = new Float32Array(W), rowS = new Float32Array(H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (grad[y * W + x] > thr) { colS[x]++; rowS[y]++; }
    const span = a => { let t = 0; for (const v of a) t += v; let s = 0, lo = 0, hi = a.length - 1; for (let i = 0; i < a.length; i++) { s += a[i]; if (s >= t * 0.03) { lo = i; break; } } s = 0; for (let i = a.length - 1; i >= 0; i--) { s += a[i]; if (s >= t * 0.03) { hi = i; break; } } return [lo, hi]; };
    [x0, x1] = span(colS); [y0, y1] = span(rowS);
    const m = 0.012; touches = (x0 <= W * m) + (x1 >= W * (1 - m)) + (y0 <= H * m) + (y1 >= H * (1 - m));
  }
  // huella del avión (para separar aviones distintos dentro de una misma ráfaga)
  let emb = null;
  if (found) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, side = Math.max(x1 - x0, y1 - y0) * 1.05;
    const e = document.createElement('canvas'); e.width = e.height = 224;
    const eg = e.getContext('2d', { willReadFrequently: true }); eg.fillStyle = '#000'; eg.fillRect(0, 0, 224, 224);
    eg.drawImage(c, cx - side / 2, cy - side / 2, side, side, 0, 0, 224, 224);
    emb = await embed(e).catch(() => null);
  }
  // nitidez (varianza del laplaciano) solo dentro del avión
  // nitidez (varianza del laplaciano) dentro del avión, medida sobre el recorte a resolución real
  // (a 720 px un avión pequeño ocupa pocos píxeles y cualquier toma parece blanda)
  let s = 0, s2 = 0, n = 0;
  {
    const sx = bmp.width / W, cw = Math.max(8, (x1 - x0) * sx), ch = Math.max(8, (y1 - y0) * sx);
    const k = Math.min(1, 1000 / cw), CW = Math.round(cw * k), CH = Math.round(ch * k);
    const cc = document.createElement('canvas'); cc.width = CW; cc.height = CH;
    const cg = cc.getContext('2d', { willReadFrequently: true }); cg.drawImage(bmp, x0 * sx, y0 * sx, cw, ch, 0, 0, CW, CH);
    const q = cg.getImageData(0, 0, CW, CH).data, gg = new Float32Array(CW * CH);
    for (let i = 0; i < CW * CH; i++) gg[i] = 0.299 * q[i * 4] + 0.587 * q[i * 4 + 1] + 0.114 * q[i * 4 + 2];
    for (let y = 1; y < CH - 1; y++) for (let x = 1; x < CW - 1; x++) { const i = y * CW + x; const l = -4 * gg[i] + gg[i - 1] + gg[i + 1] + gg[i - CW] + gg[i + CW]; s += l; s2 += l * l; n++; }
  }
  // poste o valla: columna más oscura que sus vecinas de forma continua desde abajo hasta dentro del avión
  if (found && !obst) {
    const top = Math.round(y1 - 0.3 * (y1 - y0)), rows = H - 1 - top;
    if (rows > 10) for (let x = Math.max(8, x0); x < Math.min(W - 8, x1) && !obst; x++) {
      let k = 0;
      for (let y = top; y < H - 1; y++) {
        let hit = false;
        for (let dx = -1; dx <= 1 && !hit; dx++) { const i = y * W + x + dx; if (Math.min(gray[i - 6], gray[i + 6]) - gray[i] > 12) hit = true; }
        if (hit) k++;
      }
      if (k > 0.55 * rows) obst = 1;
    }
  }
  if (bmp.close) bmp.close();
  // firma 16x12 normalizada para comparar si dos fotos muestran la misma escena
  const sc = document.createElement('canvas'); sc.width = 16; sc.height = 12; sc.getContext('2d').drawImage(c, 0, 0, 16, 12);
  const sd = sc.getContext('2d').getImageData(0, 0, 16, 12).data; const sig = new Float32Array(192);
  let mu = 0; for (let i = 0; i < 192; i++) { sig[i] = 0.299 * sd[i * 4] + 0.587 * sd[i * 4 + 1] + 0.114 * sd[i * 4 + 2]; mu += sig[i]; } mu /= 192;
  let sdv = 0; for (let i = 0; i < 192; i++) sdv += (sig[i] - mu) ** 2; sdv = Math.sqrt(sdv / 192) || 1;
  for (let i = 0; i < 192; i++) sig[i] = (sig[i] - mu) / sdv;
  return {
    sig, obst, found, emb,
    sharp: n ? (s2 / n - (s / n) ** 2) : 0,
    touches,
    fill: (x1 - x0) / W,
    thumb: URL.createObjectURL(await toBlob(small, 0.8)),
    large: URL.createObjectURL(await toBlob(big, 0.85)),
    keepBlob: await toBlob(keep, 0.78),   // la que se guarda en la nube (~30 KB)
  };
}

// Propone N (principal) y X (segunda) dentro de una ráfaga.
// Reglas de Fabri: el avión entero y sin nada delante, nítido con el foco en él; nunca una cortada,
// tapada o desenfocada si hay otra limpia. X solo si es otra fase u otro ángulo.
export function pickBest(b) {
  const ok = b.frames.filter(f => !f.err);
  b.warn = '';
  if (!ok.length) return;
  // Menos nítida: menos del 45 % de la mejor toma con el avión casi del mismo tamaño (y al menos 3 tomas para comparar)
  ok.forEach(f => {
    const peers = ok.filter(o => Math.abs(o.fill - f.fill) <= 0.15 * Math.max(o.fill, f.fill, 0.05));
    const ref = Math.max(...peers.map(o => o.sharp)) || 1;
    f.rel = f.sharp / ref; f.soft = peers.length >= 3 && f.rel < 0.45;
  });
  ok.forEach(f => f.score = 50 * f.rel + 15 * Math.min(f.fill, 0.8) - 30 * f.touches - 25 * f.obst - 40 * f.soft);
  const clean = ok.filter(f => !f.touches && !f.obst);   // «menos nítida» solo baja la nota: nunca descarta
  const pool = clean.length ? clean : ok;
  const sorted = [...pool].sort((a, c) => c.score - a.score);
  const best = sorted[0];
  b.n = best.name;
  if (!clean.length) b.warn = best.touches ? 'avión cortado en todas las tomas' : 'algo delante del avión en todas las tomas';
  // X solo si aporta algo distinto (otro ángulo o fase); dos tomas casi iguales no necesitan segunda
  const alt = sorted.slice(1).filter(f => f.score >= best.score * 0.7 && sceneDiff(f.sig, best.sig) > 0.6)
    .sort((a, c) => sceneDiff(c.sig, best.sig) - sceneDiff(a.sig, best.sig))[0];
  b.x = alt ? alt.name : '';
  // Toma suelta (1–2 fotos sin ninguna limpia, o con el avión diminuto): casi siempre un disparo
  // sin finalidad o el arranque de la ráfaga; se desmarca para no guardarla salvo que el usuario quiera
  b.loose = ok.length <= 2 && (best.fill < 0.12 || ok.every(f => f.found === false));
}

// Parte una ráfaga donde cambia el avión (huella distinta de las últimas tomas y que se mantiene en las siguientes).
// Devuelve una lista de listas de fotos. Sin huellas (detector no disponible) no parte nada.
export function splitByAircraft(frames, T = 0.12) {
  const parts = [[]]; let ref = [];
  const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const mean = vs => { const m = new Float32Array(vs[0].length); vs.forEach(v => v.forEach((x, i) => m[i] += x)); let n = 0; m.forEach(x => n += x * x); n = Math.sqrt(n) || 1; return m.map(x => x / n); };
  frames.forEach((f, i) => {
    if (f.emb && ref.length) {
      const r = mean(ref.slice(-3)), d = 1 - cos(r, f.emb);
      const next = frames.slice(i + 1).filter(n => n.emb).slice(0, 2);
      const persists = next.every(n => 1 - cos(r, n.emb) > T * 0.8);
      if (d > T && persists && parts[parts.length - 1].length) { parts.push([]); ref = []; }
    }
    parts[parts.length - 1].push(f); if (f.emb) ref.push(f.emb);
  });
  return parts;
}

// 0 = idénticas; >0.6 suele ser otra escena
export function sceneDiff(a, b) { if (!a || !b) return 9; let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; }
