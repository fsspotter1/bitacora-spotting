// Lectura local de RAW: vista previa JPEG embebida + hora de captura. Nada sale del ordenador.
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

// Nitidez dentro de la caja del avión + si toca el borde. Devuelve miniaturas.
export async function analyse(blob) {
  const bmp = await createImageBitmap(blob);
  const W = 360, H = Math.round(bmp.height * W / bmp.width);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, W, H);
  const big = document.createElement('canvas'); const BW = 900, BH = Math.round(bmp.height * BW / bmp.width); big.width = BW; big.height = BH; big.getContext('2d').drawImage(bmp, 0, 0, BW, BH);
  const keep = document.createElement('canvas'); const KW = 480, KH = Math.round(bmp.height * KW / bmp.width); keep.width = KW; keep.height = KH; keep.getContext('2d').drawImage(bmp, 0, 0, KW, KH);
  if (bmp.close) bmp.close();
  const px = g.getImageData(0, 0, W, H).data, gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const grad = new Float32Array(W * H); const vals = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; const v = Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + W] - gray[i - W]); grad[i] = v; if ((x + y) % 3 === 0) vals.push(v); }
  vals.sort((a, b) => a - b); const thr = vals[Math.floor(vals.length * 0.95)] || 0;
  const colS = new Float32Array(W), rowS = new Float32Array(H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (grad[y * W + x] > thr) { colS[x]++; rowS[y]++; }
  const span = a => { let t = 0; for (const v of a) t += v; let s = 0, lo = 0, hi = a.length - 1; for (let i = 0; i < a.length; i++) { s += a[i]; if (s >= t * 0.03) { lo = i; break; } } s = 0; for (let i = a.length - 1; i >= 0; i--) { s += a[i]; if (s >= t * 0.03) { hi = i; break; } } return [lo, hi]; };
  const [x0, x1] = span(colS), [y0, y1] = span(rowS);
  let s = 0, s2 = 0, n = 0;
  for (let y = Math.max(1, y0); y < Math.min(H - 1, y1); y++) for (let x = Math.max(1, x0); x < Math.min(W - 1, x1); x++) { const i = y * W + x; const l = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - W] + gray[i + W]; s += l; s2 += l * l; n++; }
  const m = 0.012;
  // firma 16x12 normalizada para comparar si dos fotos muestran la misma escena
  const sc = document.createElement('canvas'); sc.width = 16; sc.height = 12; sc.getContext('2d').drawImage(c, 0, 0, 16, 12);
  const sd = sc.getContext('2d').getImageData(0, 0, 16, 12).data; const sig = new Float32Array(192);
  let mu = 0; for (let i = 0; i < 192; i++) { sig[i] = 0.299 * sd[i * 4] + 0.587 * sd[i * 4 + 1] + 0.114 * sd[i * 4 + 2]; mu += sig[i]; } mu /= 192;
  let sdv = 0; for (let i = 0; i < 192; i++) sdv += (sig[i] - mu) ** 2; sdv = Math.sqrt(sdv / 192) || 1;
  for (let i = 0; i < 192; i++) sig[i] = (sig[i] - mu) / sdv;
  return {
    sig,
    sharp: n ? (s2 / n - (s / n) ** 2) : 0,
    touches: (x0 <= W * m) + (x1 >= W * (1 - m)) + (y0 <= H * m) + (y1 >= H * (1 - m)),
    fill: (x1 - x0) / W,
    thumb: URL.createObjectURL(await toBlob(c, 0.8)),
    large: URL.createObjectURL(await toBlob(big, 0.85)),
    keepBlob: await toBlob(keep, 0.78),   // la que se guarda en la nube (~30 KB)
  };
}

// Propone N (principal) y X (segunda) dentro de una ráfaga.
export function pickBest(b) {
  const ok = b.frames.filter(f => !f.err);
  if (!ok.length) return;
  const max = Math.max(...ok.map(f => f.sharp)) || 1;
  ok.forEach(f => f.score = 70 * f.sharp / max - 18 * f.touches + 12 * Math.min(f.fill, 0.8));
  const sorted = [...ok].sort((a, c) => c.score - a.score);
  b.n = sorted[0].name;
  // X solo si aporta algo distinto (otro ángulo o fase); dos tomas casi iguales no necesitan segunda
  const best = sorted[0];
  const alt = sorted.slice(1).filter(f => f.score >= best.score * 0.7 && sceneDiff(f.sig, best.sig) > 0.6)
    .sort((a, c) => sceneDiff(c.sig, best.sig) - sceneDiff(a.sig, best.sig))[0];
  b.x = alt ? alt.name : '';
}

// 0 = idénticas; >0.6 suele ser otra escena
export function sceneDiff(a, b) { if (!a || !b) return 9; let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; }
