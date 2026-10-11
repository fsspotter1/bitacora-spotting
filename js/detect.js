// Detector de objetos (SSD-MobileNet v1, COCO) en el navegador con onnxruntime-web.
// Solo se usa para saber DÓNDE está el avión (y si hay personas, vehículos u otro avión delante).
// Si no carga (sin conexión, navegador antiguo), la web sigue con el método sencillo.
const ORT = globalThis.ORT_BASE || 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
let sessionP = null, embP = null, chain = Promise.resolve();
export function loadDetector() {
  if (!sessionP) sessionP = (async () => {
    const ort = await import(ORT + 'ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = ORT; ort.env.wasm.numThreads = 1;
    const s = await ort.InferenceSession.create('models/ssd_mobilenet_v1.onnx', { executionProviders: ['wasm'] });
    return { ort, s };
  })().catch(e => { console.warn('Detector no disponible:', e); return null; });
  return sessionP;
}
// canvas → [{cls, score, box:[x0,y0,x1,y1]}] en coordenadas 0–1
export async function detect(canvas) {
  const d = await loadDetector(); if (!d) return null;
  const run = async () => {
    const W = canvas.width, H = canvas.height;
    const px = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const rgb = new Uint8Array(W * H * 3);
    for (let i = 0, j = 0; i < W * H; i++, j += 3) { rgb[j] = px[i * 4]; rgb[j + 1] = px[i * 4 + 1]; rgb[j + 2] = px[i * 4 + 2]; }
    const t = new d.ort.Tensor('uint8', rgb, [1, H, W, 3]);
    const o = await d.s.run({ [d.s.inputNames[0]]: t });
    const n = o.num_detections.data[0], B = o.detection_boxes.data, C = o.detection_classes.data, S = o.detection_scores.data, out = [];
    for (let i = 0; i < n; i++) if (S[i] > 0.3) out.push({ cls: Math.round(C[i]), score: S[i], box: [B[i * 4 + 1], B[i * 4], B[i * 4 + 3], B[i * 4 + 2]] });
    return out;
  };
  const p = chain.then(run, run); chain = p.catch(() => {}); return p;
}

// Huella visual del avión (MobileNetV2, 1280 valores) para saber si dos tomas son del mismo avión.
export function loadEmbedder() {
  if (!embP) embP = (async () => {
    const d = await loadDetector(); if (!d) return null;
    const s = await d.ort.InferenceSession.create('models/mobilenet_v2_feat.onnx', { executionProviders: ['wasm'] });
    return { ort: d.ort, s };
  })().catch(e => { console.warn('Huella no disponible:', e); return null; });
  return embP;
}
// canvas 224×224 con el avión → vector normalizado
export async function embed(canvas) {
  const d = await loadEmbedder(); if (!d) return null;
  const run = async () => {
    const N = 224, px = canvas.getContext('2d').getImageData(0, 0, N, N).data, a = new Float32Array(3 * N * N);
    const M = [0.485, 0.456, 0.406], S = [0.229, 0.224, 0.225];
    for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) a[c * N * N + i] = (px[i * 4 + c] / 255 - M[c]) / S[c];
    const o = await d.s.run({ [d.s.inputNames[0]]: new d.ort.Tensor('float32', a, [1, 3, N, N]) });
    const v = o[d.s.outputNames[0]].data; let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    return Float32Array.from(v, x => x / n);
  };
  const p = chain.then(run, run); chain = p.catch(() => {}); return p;
}
