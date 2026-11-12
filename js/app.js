import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { RAW_RE, readFrame, captureTime, analyse, pickBest, sceneDiff, splitByAircraft, DETECTAR_CORTES } from './raw.js';
import { loadDetector, loadEmbedder } from './detect.js';
import { identificar, claveReg, fichasDeBitacora } from './ia.js';
import { rangosCamara, descargarDia, juntarDias, anclas, calibrar, candidatos, decidir, resumir, fechasUtc, regPropia, familia, paredDe, ADSB_DESDE, delanteEn } from './adsb.js';
import { detectar, diasNecesarios, desfaseCasa, desfaseZona } from './escalas.js';

const SUPABASE_URL = 'https://vhhpbulykxiqfwarxlfu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_lXi2rPoZx8ofeM46jqwBlA_PaSQ2JSX'; // clave pública
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = n => (n || '').replace(/\.[^.]+$/, '');
const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2600); }

let user = null;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const S = { entries: [], filter: 'all', q: '', thumbs: new Map(), editing: null };

/* ---------------- acceso ---------------- */
async function boot() {
  const { data } = await sb.auth.getSession();
  setUser(data.session?.user || null);
  sb.auth.onAuthStateChange((_e, session) => setUser(session?.user || null));
}
function setUser(u) {
  const changed = (u?.id || null) !== (user?.id || null);
  user = u;
  $('#nav').hidden = !u; $('#v-auth').hidden = !!u;
  $('#who').textContent = u ? u.email : 'Beta privada';
  if (!u) { $('#v-log').hidden = $('#v-add').hidden = true; return; }
  if (changed) { show('log'); loadEntries(); }
}
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#authMsg'); msg.className = 'msg'; msg.textContent = 'Entrando…';
  const { error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#pass').value });
  if (error) { msg.className = 'msg err'; msg.textContent = error.message === 'Invalid login credentials' ? 'Correo o contraseña incorrectos. Si no tienes cuenta, pulsa «Crear cuenta».' : error.message; }
});
$('#signupBtn').onclick = async () => {
  const msg = $('#authMsg'); const email = $('#email').value.trim(), password = $('#pass').value;
  if (!email || password.length < 6) { msg.className = 'msg err'; msg.textContent = 'Escribe tu correo y una contraseña de al menos 6 caracteres.'; return; }
  msg.className = 'msg'; msg.textContent = 'Creando cuenta…';
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) { msg.className = 'msg err'; msg.textContent = error.message; return; }
  if (!data.session) { msg.className = 'msg ok'; msg.textContent = 'Cuenta creada. Revisa tu correo para confirmarla y luego entra.'; }
};
$('#logout').onclick = () => sb.auth.signOut();

/* ---------------- navegación ---------------- */
function show(v) {
  $('#v-log').hidden = v !== 'log'; $('#v-add').hidden = v !== 'add';
  $$('.tab').forEach(t => t.toggleAttribute('aria-current', t.dataset.view === v));
  $$('.tab').forEach(t => { if (t.dataset.view === v) t.setAttribute('aria-current', 'page'); });
}
$$('.tab').forEach(t => t.onclick = () => show(t.dataset.view));

/* ---------------- bitácora ---------------- */
async function loadEntries() {
  $('#logStat').textContent = 'Cargando…';
  const all = []; let from = 0;
  for (;;) {
    const { data, error } = await sb.from('entries').select('*').order('fecha', { ascending: false }).order('created_at', { ascending: false }).range(from, from + 999);
    if (error) { $('#logStat').textContent = 'No se pudo cargar la bitácora: ' + error.message; return; }
    all.push(...data); if (data.length < 1000) break; from += 1000;
  }
  S.entries = all; fichasDeBitacora(all); renderLog(); loadThumbs();
}
async function loadThumbs() {
  const need = S.entries.filter(e => e.thumb_path && !S.thumbs.has(e.thumb_path)).map(e => e.thumb_path);
  for (let i = 0; i < need.length; i += 100) {
    const { data } = await sb.storage.from('thumbs').createSignedUrls(need.slice(i, i + 100), 3600 * 6);
    (data || []).forEach(d => d.signedUrl && S.thumbs.set(d.path, d.signedUrl));
    renderLog();
  }
}
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function visible() {
  const q = norm(S.q).trim();
  return S.entries.filter(e => (S.filter === 'all' || (S.filter === 'pend') === e.pendiente) &&
    (!q || q.split(/\s+/).every(t => norm([e.matricula, e.tipo, e.operador, e.aeropuerto, e.carpeta, e.carpeta.replace(/[+_-]/g, ' '), e.archivo, e.archivo2, e.fecha, e.nota].join(' ')).includes(t))));
}
function renderLog() {
  const list = visible();
  const pend = S.entries.filter(e => e.pendiente).length;
  $('#cPend').textContent = pend || '';
  $('#logEmpty').hidden = S.entries.length > 0;
  $('#logStat').textContent = S.entries.length ? `${list.length} de ${S.entries.length} registros · ${new Set(S.entries.map(e => e.matricula).filter(Boolean)).size} matrículas` : '';
  $('#entries').innerHTML = list.slice(0, 400).map(e => {
    const img = e.thumb_path && S.thumbs.get(e.thumb_path);
    return `<button class="card" data-id="${e.id}">
      ${img ? `<img class="ph" src="${img}" alt="" loading="lazy">` : '<div class="ph"></div>'}
      <div class="bd">
        <div class="rg">${esc(e.matricula || 'Sin matrícula')}${e.pendiente ? '<span class="pill">pendiente</span>' : ''}</div>
        <div class="ln">${esc([e.tipo, e.operador].filter(Boolean).join(' · ') || '—')}</div>
        <div class="fl">${esc([e.fecha, e.aeropuerto].filter(Boolean).join(' · '))}</div>
        <div class="fl">${esc(e.carpeta)} / ${esc(e.archivo)}</div>
      </div></button>`;
  }).join('') + (list.length > 400 ? `<p class="stat">Mostrando 400 de ${list.length}. Afina la búsqueda para ver el resto.</p>` : '');
}
$('#q').addEventListener('input', e => { S.q = e.target.value; renderLog(); });
$$('.chip').forEach(c => c.onclick = () => { S.filter = c.dataset.f; $$('.chip').forEach(x => x.setAttribute('aria-pressed', x === c)); renderLog(); });
$('#entries').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) openEditor(c.dataset.id); });

/* editor */
const ED = { matricula: '#edReg', fecha: '#edFecha', tipo: '#edTipo', operador: '#edOp', aeropuerto: '#edApt', carpeta: '#edCarp', archivo: '#edN', archivo2: '#edX', nota: '#edNota' };
function openEditor(id) {
  const e = S.entries.find(x => x.id === id); if (!e) return; S.editing = e;
  for (const [k, sel] of Object.entries(ED)) $(sel).value = e[k] ?? '';
  const img = e.thumb_path && S.thumbs.get(e.thumb_path); $('#edImg').src = img || ''; $('#edImg').hidden = !img;
  $('#edApprove').textContent = e.pendiente ? 'Aprobar' : 'Guardar'; $('#edSave').hidden = !e.pendiente;
  $('#edDelYes').hidden = true; $('#edDel').hidden = false;
  $('#editor').showModal();
}
async function saveEditor(approve) {
  const e = S.editing; const patch = {};
  for (const [k, sel] of Object.entries(ED)) { let v = $(sel).value.trim(); if (k === 'matricula' || k === 'aeropuerto') v = v.toUpperCase(); patch[k] = k === 'fecha' ? (v || null) : v; }
  if (approve) patch.pendiente = false;
  const { error } = await sb.from('entries').update(patch).eq('id', e.id);
  if (error) { toast('No se guardó: ' + error.message); return; }
  Object.assign(e, patch); $('#editor').close(); renderLog(); toast(approve && e.pendiente === false ? 'Aprobada' : 'Guardado');
}
$('#edSave').onclick = () => saveEditor(false);
$('#edApprove').onclick = () => saveEditor(true);
$('#edDel').onclick = () => { $('#edDel').hidden = true; $('#edDelYes').hidden = false; };
$('#edDelYes').onclick = async () => {
  const e = S.editing;
  const { error } = await sb.from('entries').delete().eq('id', e.id);
  if (error) { toast('No se borró: ' + error.message); return; }
  if (e.thumb_path) sb.storage.from('thumbs').remove([e.thumb_path]);
  S.entries = S.entries.filter(x => x !== e); $('#editor').close(); renderLog(); toast('Borrado');
};

/* exportar */
$('#exportBtn').onclick = () => {
  const cols = ['fecha', 'matricula', 'tipo', 'operador', 'aeropuerto', 'carpeta', 'archivo', 'archivo2', 'nota', 'pendiente'];
  const csv = [cols.join(',')].concat(visible().map(e => cols.map(k => { const v = String(e[k] ?? ''); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(','))).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `Bitacora spotting ${ymd(Date.now())}.csv`; a.click();
};

/* empezar de cero */
$('#resetTxt').addEventListener('input', e => $('#resetBtn').disabled = e.target.value.trim().toUpperCase() !== 'BORRAR');
$('#resetBtn').onclick = async () => {
  const msg = $('#resetMsg'); $('#resetBtn').disabled = true; msg.className = 'msg'; msg.textContent = 'Borrando…';
  // miniaturas
  let removed = 0;
  for (;;) {
    const { data, error } = await sb.storage.from('thumbs').list(user.id, { limit: 100 });
    if (error || !data?.length) break;
    const paths = data.map(o => `${user.id}/${o.name}`);
    const r = await sb.storage.from('thumbs').remove(paths); if (r.error) break;
    removed += paths.length; msg.textContent = `Borrando miniaturas… ${removed}`;
  }
  const { error } = await sb.from('entries').delete().eq('user_id', user.id);
  if (error) { msg.className = 'msg err'; msg.textContent = 'No se pudo borrar: ' + error.message; $('#resetBtn').disabled = false; return; }
  S.entries = []; S.thumbs.clear(); bursts = []; $('#bursts').innerHTML = ''; $('#saveBar').hidden = true;
  $('#resetTxt').value = ''; $('#resetZone').open = false; msg.textContent = '';
  renderLog(); toast('Bitácora vacía: puedes empezar de cero');
};

/* ---------------- registrar carpeta ---------------- */
let bursts = [], folder = '', paresJpg = 0;
$('#pickBtn').onclick = () => { loadDetector(); loadEmbedder(); $('#pick').click(); };
$('#pick').onchange = async ev => {
  const files = [...ev.target.files].filter(f => RAW_RE.test(f.name) && !f.name.startsWith('.'));
  ev.target.value = '';
  if (!files.length) { $('#addStat').textContent = 'No hay RAW en esa carpeta.'; return; }
  folder = (files[0].webkitRelativePath || '').split('/')[0] || '';
  bursts = []; $('#bursts').innerHTML = ''; $('#saveBar').hidden = true; $('#aiBar').hidden = true; $('#pickBtn').disabled = true; AI.stopped = '';
  clearTimeout(ADSB.timer); Object.assign(ADSB, { apts: new Map(), cal: null, manual: null, hDet: null, error: '' }); $('#adsbBar').hidden = true;
  tramos = []; Object.assign(DET, { fase: 1, estadoTramo: new Map(), otraVez: false });
  const total = files.length; let done = 0; const frames = [];
  const prog = t => { $('#bar').style.width = (100 * done / total) + '%'; $('#addStat').textContent = t; };
  for (const f of files) {
    try { const r = await readFrame(f); frames.push({ name: f.name, blob: r.blob, t: captureTime(r.date, f) }); }
    catch { frames.push({ name: f.name, t: f.lastModified, err: true }); }
    if (++done % 20 === 0) prog(`Leyendo ${done}/${total}`);
  }
  frames.sort((a, b) => a.t - b.t || a.name.localeCompare(b.name));
  paresJpg = unirParesRawJpg(frames);
  const gap = HUECO_RAFAGA; let cur = [];
  frames.forEach((f, i) => { if (i && f.t - frames[i - 1].t > gap) { bursts.push({ frames: cur }); cur = []; } cur.push(f); });
  if (cur.length) bursts.push({ frames: cur });
  bursts.forEach(b => Object.assign(b, { reg: '', type: '', op: '', on: true, touched: {} }));
  renumber();
  done = 0;
  let splits = 0;
  for (let bi = 0; bi < bursts.length; bi++) {
    const b = bursts[bi], queue = [...b.frames];
    await Promise.all([0, 1, 2].map(async () => { while (queue.length) { const f = queue.shift(); if (!f.err) { try { Object.assign(f, await analyse(f.blob)); } catch { f.err = true; } } done++; } }));
    // en el spot se dispara sin pausa a aviones seguidos: si cambia el avión, es otro registro
    const parts = splitByAircraft(b.frames);
    if (parts.length > 1) {
      const nbs = parts.map((fr, k) => k ? { frames: fr, reg: '', type: '', op: '', on: true, auto: true, touched: {}, tramo: b.tramo } : Object.assign(b, { frames: fr }));
      bursts.splice(bi, 1, ...nbs); renumber(); splits += parts.length - 1;
      nbs.forEach(x => { pickBest(x); desmarcarSuelta(x); });
      bi += nbs.length - 1; $('#bursts').innerHTML = ''; bursts.slice(0, bi + 1).forEach(renderBurst);
    } else { pickBest(b); desmarcarSuelta(b); renderBurst(b); }
    prog(`Analizando ${done}/${total} · ráfaga ${bi + 1}/${bursts.length}` + (splits ? ` · ${splits} separadas por cambio de avión` : ''));
  }
  calcularTramos(); markSimilar(); renderAll();
  $('#bar').style.width = '100%';
  $('#pickBtn').disabled = false; $('#saveBar').hidden = false; updateSave();
  AI.stopped = ''; updateAIBar();
  if (aiOn()) runAI();
  iniciarADSB();
};
function renumber() { bursts.forEach((b, i) => b.id = i); }
// Primer corte de ráfagas: más de 8 s sin fotos = otro avión. Antes era un ajuste; ahora lo corrige solo el ADS-B
// (reagruparADSB) en cuanto la cámara está en hora: junta las del mismo avión y separa las que tienen dos.
const HUECO_RAFAGA = 8000;
// Con RAW+JPG, la cámara guarda la misma foto dos veces (FSS_2195.NEF y FSS_2195.JPG, a la misma hora): se queda una
// sola toma, el RAW (o el JPG si el RAW no se pudo leer). Mismo nombre a otra hora (contador reiniciado) = otra foto.
// Cambia la lista en su sitio (ordenada por hora) y devuelve cuántas copias se quitaron.
function unirParesRawJpg(frames) {
  const jpg = f => /\.jpe?g$/i.test(f.name), out = [], porNombre = new Map(); let quitadas = 0;
  for (const f of frames) {
    const k = base(f.name).toUpperCase();
    const i = (porNombre.get(k) || []).find(j => Math.abs(out[j].t - f.t) <= 2000 && jpg(out[j]) !== jpg(f));
    if (i === undefined) { porNombre.set(k, [...(porNombre.get(k) || []), out.length]); out.push(f); continue; }
    quitadas++;
    const o = out[i];
    if ((o.err && !f.err) || (!f.err && jpg(o) && !jpg(f))) out[i] = f;
  }
  frames.splice(0, frames.length, ...out);
  return quitadas;
}
// Toma suelta (1–2 fotos sin avión detectado o con el avión diminuto): se desmarca para no guardarla, salvo que tú la
// hayas marcado. offPor guarda el porqué para decirlo en la tarjeta (y para que la IA revise las «sin avión»).
function desmarcarSuelta(b) { if (b.loose && !b.touched?.on) { b.on = false; b.offPor = b.suelta || 'diminuto'; } }
// Ráfagas que la IA identifica sola: las marcadas para guardar y las tomas sueltas en las que el detector del navegador
// no vio avión (falla con poca luz, p. ej. el Binter al anochecer). Las que desmarcas tú no se tocan.
const pendienteIA = b => !!b.n && !b.ai && (b.on || (b.offPor === 'sin_avion' && !b.touched?.on));
const lastOk = b => [...b.frames].reverse().find(f => f.sig), firstOk = b => b.frames.find(f => f.sig);
// Avión parado (nocturnas, rampa): ráfagas separadas en el tiempo pero con la misma escena
function markSimilar() {
  bursts.forEach((b, i) => {
    const p = bursts[i - 1];
    // con matrícula en las dos (escrita o leída por la IA), manda la matrícula: si son distintas, no es el mismo avión
    const regsDiffer = claveReg(p?.reg) && claveReg(b.reg) && claveReg(p.reg) !== claveReg(b.reg);
    b.similar = !b.auto && !!p && !regsDiffer && b.frames[0].t - p.frames[p.frames.length - 1].t < 20 * 60 * 1000 && sceneDiff(lastOk(p)?.sig, firstOk(b)?.sig) < 0.35;
  });
}
function renderAll() {
  $('#bursts').innerHTML = '';
  let ultimo, n = 0;
  for (const b of bursts) {
    if (tramos.length && b.tramo !== ultimo) { ultimo = b.tramo; const t = tramoDe(b); if (t) $('#bursts').insertAdjacentHTML('beforeend', cabeceraTramo(t, ++n)); }
    renderBurst(b);
  }
  renderStat();
}
// Unir a mano: si la había separado el ADS-B, ya no la vuelve a separar
function mergeWithPrev(i) { const p = bursts[i - 1]; if (p) p.sinCortesADSB = true; mergeBursts(i - 1, i); }
const RANGO = { alta: 3, media: 2, baja: 1 };
const valorIA = a => a ? (a.matricula ? 10 : 0) + (a.matricula_parcial ? 2 : 0) + (a.verificado ? 5 : 0) + (RANGO[a.confianza] || 0) : -1;
// Une la ráfaga j con la i (no hace falta que sean seguidas: p. ej. el que rodaba, uno que aterriza y otra vez el que rodaba)
function mergeBursts(i, j, quiet) {
  const p = bursts[i], b = bursts[j]; if (!p || !b || p === b) return;
  p.frames = p.frames.concat(b.frames).sort((x, y) => x.t - y.t || x.name.localeCompare(y.name));
  ['reg', 'type', 'op'].forEach(k => { if (!p[k] && b[k]) { p[k] = b[k]; if (b.touched?.[k]) p.touched[k] = true; } });
  if (!p.regAdsb && b.regAdsb && p.reg === b.regAdsb) p.regAdsb = b.regAdsb;
  if (!p.tipoAdsb && b.tipoAdsb && p.type === b.tipoAdsb) p.tipoAdsb = b.tipoAdsb;
  if (b.ai && valorIA(b.ai) > valorIA(p.ai)) p.ai = b.ai;
  p.on = p.on || b.on;
  p.offPor = p.on ? '' : p.offPor || b.offPor || '';
  bursts.splice(j, 1); delete b.auto; pickBest(p); delete p.view; renumber(); markSimilar(); markDups();
  if (quiet) return;
  renderAll(); updateSave(); updateAIBar();
  document.getElementById('b' + p.id)?.scrollIntoView({ block: 'nearest' });
}
// porADSB: { delante } si la separa el ADS-B (se dice en la tarjeta); si no, la separas tú y no se vuelve a juntar sola
function splitAt(i, name, porADSB) {
  const b = bursts[i]; const k = b.frames.findIndex(f => f.name === name); if (k <= 0) return;
  const nb = { frames: b.frames.slice(k), reg: '', type: '', op: '', on: true, auto: porADSB ? 'adsb' : false, delante: porADSB?.delante || '', mano: !porADSB, touched: {}, tramo: b.tramo };
  // la identificación era de la ráfaga entera: se repite para las dos partes
  b.ai = null; b.aiErr = ''; b.adsb = null; ['reg', 'type', 'op'].forEach(kk => { if (!b.touched?.[kk]) b[kk] = ''; });
  b.regAdsb = ''; b.tipoAdsb = '';
  b.frames = b.frames.slice(0, k); pickBest(b); pickBest(nb); delete b.view;
  bursts.splice(i + 1, 0, nb); renumber();
  if (porADSB) return [b, nb];
  markSimilar(); markDups(); renderAll(); updateSave();
  if (aiOn()) runAI([b, nb]);
}
const hm = t => new Date(t).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
// Por qué una ráfaga está sin marcar (si la desmarcó la web; si la desmarcas tú, no hace falta decirlo)
function avisoDesmarcada(b) {
  if (b.on || b.touched?.on || !b.offPor || b.offPor === 'ia') return '';
  if (b.offPor === 'sin_avion') return b.ai ? '' : aiOn()
    ? 'Toma suelta en la que el detector no ve ningún avión (pasa con poca luz): la IA la revisa y, si ve uno, la marca para guardar.'
    : 'Toma suelta en la que el detector no ve ningún avión (pasa con poca luz). No se guardará salvo que marques «Guardar».';
  return 'Toma suelta: el avión sale muy pequeño en 1–2 fotos (parece un disparo sin finalidad o el inicio de una ráfaga). No se guardará salvo que marques «Guardar».';
}
function renderBurst(b) {
  let el = document.getElementById('b' + b.id);
  if (!el) { el = document.createElement('article'); el.id = 'b' + b.id; $('#bursts').appendChild(el); }
  el.className = 'burst' + (b.on ? '' : ' off');
  const view = b.view || b.n; const vF = b.frames.find(f => f.name === view); const k = b.frames.length;
  const role = view === b.n ? 'Principal' : view === b.x ? 'Segunda' : 'Viendo';
  el.innerHTML = `
    <div class="side">
      <div class="hero">${vF?.large ? `<img src="${vF.large}" alt="${esc(base(view))}">` : ''}<span class="badge ${role === 'Segunda' ? 'x' : role === 'Viendo' ? 'v' : ''}">${role} · ${esc(view ? base(view) : '—')}</span></div>
      <div class="row">
        <button class="btn sm ${view === b.n ? 'on' : ''}" data-act="n" ${view === b.n ? 'disabled' : ''}>★ Principal</button>
        <button class="btn sm ${view === b.x ? 'on x' : ''}" data-act="x">${view === b.x ? 'Quitar segunda' : 'Segunda'}</button>
        ${view !== b.frames[0].name && k > 1 ? '<button class="btn sm ghost" data-act="split" title="Esta foto y las siguientes pasan a otra ráfaga">Separar desde aquí</button>' : ''}
      </div>
    </div>
    <div class="meta">
      ${b.similar ? `<div class="similar"><span>Parece el mismo avión que la ráfaga anterior.</span><button class="btn sm" data-act="merge">Unir con la anterior</button></div>` : ''}
      ${b.auto === 'adsb' ? `<div class="similar"><span>Separada con el ADS-B: a esa hora pasaba otro avión por delante${b.delante ? ` (${esc(b.delante)})` : ''}.</span><button class="btn sm" data-act="merge">Es el mismo: unir</button></div>`
        : b.auto ? '<div class="similar"><span>Separada automáticamente: parece otro avión que la ráfaga anterior.</span><button class="btn sm" data-act="merge">Es el mismo: unir</button></div>' : ''}
      ${avisoDesmarcada(b) ? `<p class="warnline">${avisoDesmarcada(b)}</p>` : b.warn ? `<p class="warnline">⚠ ${esc(b.warn)}: revisa la ráfaga.</p>` : ''}
      <div class="row"><span class="time">${hm(b.frames[0].t)}</span><span class="files">${esc(base(b.frames[0].name))} – ${esc(base(b.frames[k - 1].name))} · ${k} ${k === 1 ? 'foto' : 'fotos'}</span>
        ${b.id > 0 && !b.similar && !b.auto ? '<button class="btn sm ghost" data-act="merge">Unir con la anterior</button>' : ''}
        ${tramos.length && bursts.find(x => x.tramo === b.tramo) !== b ? '<button class="btn sm ghost" data-act="tramo" title="Esta ráfaga y las siguientes de su tramo pasan a un tramo nuevo con otro aeropuerto">Otro aeropuerto desde aquí</button>' : ''}</div>
      ${dupBanner(b)}${otherBanner(b)}
      <div class="inputs">
        <input type="text" class="reg${byAI(b, 'reg')}${byADSB(b, 'reg')}" data-k="reg" placeholder="Matrícula" value="${esc(b.reg)}" aria-label="Matrícula">
        <input type="text" data-k="type" class="${byAI(b, 'type')}${byADSB(b, 'type')}" placeholder="Tipo (A320)" value="${esc(b.type)}" aria-label="Tipo">
        <input type="text" data-k="op" class="${byAI(b, 'op')}" placeholder="Operador" value="${esc(b.op)}" aria-label="Operador">
        <label class="field"><input type="checkbox" data-k="on" ${b.on ? 'checked' : ''}> Guardar</label>
      </div>
      ${aiLine(b)}
      ${adsbLine(b)}
      <div class="strip">${b.frames.map(f => `<button class="th ${f.name === view ? 'v' : ''}" data-f="${esc(f.name)}" title="${esc(f.name)}">${f.thumb ? `<img src="${f.thumb}" alt="">` : ''}${f.name === b.n ? '<span class="tagn">★ N</span>' : f.name === b.x ? '<span class="tagx">X</span>' : ''}${f.err ? '<span class="bad">sin previa</span>' : DETECTAR_CORTES && f.cortadoIA ? '<span class="bad">cortado</span>' : DETECTAR_CORTES && f.obst ? '<span class="bad">algo delante</span>' : DETECTAR_CORTES && f.touches && !f.enteroIA ? '<span class="bad soft" title="Puede que el avión se salga del encuadre; la IA lo comprueba en la principal">¿cortado?</span>' : f.soft ? '<span class="bad soft">¿menos nítida?</span>' : ''}<span class="num">${esc(base(f.name).slice(-4))}</span></button>`).join('')}</div>
      <p class="hint">Haz clic en la foto grande para verla a pantalla completa, y en una miniatura para verla en grande y elige si es la <b>principal (★ N)</b> o la <b>segunda (X)</b>.</p>
    </div>`;
  el.querySelectorAll('input[data-k]').forEach(i => {
    i.oninput = () => {
      const kk = i.dataset.k; b[kk] = kk === 'on' ? i.checked : (kk === 'reg' ? i.value.toUpperCase().trim() : i.value.trim());
      b.touched[kk] = true; if (kk !== 'on') i.classList.remove('byai');
      if (kk === 'on') el.classList.toggle('off', !b.on); updateSave();
    };
    i.onchange = () => { i.oninput(); if (i.dataset.k === 'reg' || i.dataset.k === 'type') { if (i.dataset.k === 'reg') { b.regAdsb = ''; programarDeteccion(); } markSimilar(); markDups(); renderAll(); updateAIBar(); programarCruce(); } };
  });
}
$('#bursts').addEventListener('click', e => {
  const art = e.target.closest('.burst'); if (!art) return;
  const b = bursts[+art.id.slice(1)]; if (!b) return;
  if (e.target.matches('.hero img')) { const z = document.createElement('div'); z.id = 'zoom'; z.innerHTML = `<img src="${e.target.src}" alt="">`; z.onclick = () => z.remove(); document.body.appendChild(z); return; }
  const t = e.target.closest('.th');
  if (t) { b.view = t.dataset.f; renderBurst(b); return; }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const view = b.view || b.n;
  if (a.dataset.act === 'n') { if (b.x === view) b.x = b.n; b.n = view; }
  else if (a.dataset.act === 'x') { b.x = b.x === view ? '' : view; if (b.x === b.n) b.x = ''; }
  else if (a.dataset.act === 'merge') return mergeWithPrev(b.id);
  else if (a.dataset.act === 'split') return splitAt(b.id, view);
  else if (a.dataset.act === 'ai') return runAI([b], true);
  else if (a.dataset.act === 'tramo') return otroAeropuertoDesde(b);
  else if (a.dataset.act === 'mergedup') { const t = bursts.find(x => x.id === b.dupOf); if (t) mergeBursts(t.id, b.id); return; }
  else if (a.dataset.act === 'adsbusar') return usarADSB(b, a.dataset.reg, a.dataset.tipo);
  else if (a.dataset.act === 'aiview') { b.view = a.dataset.f; renderBurst(b); document.getElementById('b' + b.id)?.scrollIntoView({ block: 'nearest' }); return; }
  renderBurst(b);
});
/* ---------------- v0.2 · identificación con IA ---------------- */
const AI = { busy: new Set(), stopped: '' };
// Prueba Haiku vs Sonnet: abre la web con ?comparar y cada ráfaga se lee con los dos modelos (cuesta ~20 veces más)
const COMPARAR = new URLSearchParams(location.search).has('comparar');
const aiOn = () => $('#useAI').checked;
try { const v = localStorage.getItem('bs-useAI'); if (v !== null) $('#useAI').checked = v === '1'; } catch { /* sin almacenamiento */ }
$('#useAI').onchange = () => {
  try { localStorage.setItem('bs-useAI', aiOn() ? '1' : '0'); } catch { /* sin almacenamiento */ }
  bursts.forEach(renderBurst); updateAIBar(); if (aiOn() && bursts.length) runAI(null, true);
};
const hhmm = t => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

// list: ráfagas concretas (se identifican aunque ya lo estuvieran); sin list: las marcadas que faltan
async function runAI(list, retry) {
  if (retry) AI.stopped = '';
  if (AI.stopped) { updateAIBar(); return; }
  const todo = (list || bursts.filter(pendienteIA)).filter(b => b.n && !AI.busy.has(b));
  if (!todo.length) { updateAIBar(); return; }
  const queue = [...todo];
  todo.forEach(b => { AI.busy.add(b); b.aiErr = ''; refresh(b); });
  updateAIBar();
  // allSettled + try/finally: aunque una ráfaga falle (o falle al pintarse), el resto sigue y el paso final se hace siempre
  await Promise.allSettled([0, 1, 2].map(async () => {
    while (queue.length) {
      const b = queue.shift();
      try {
        if (AI.stopped || !bursts.includes(b)) continue;   // parada o ya unida con otra
        const { data } = await sb.auth.getSession();
        const token = data.session?.access_token;
        if (!token) { const e = new Error('Vuelve a entrar en la web para usar la IA.'); e.code = 'sin_sesion'; throw e; }
        applyAI(b, await identificar(b, { token, aeropuerto: aptDe(b), fecha: ymd(b.frames[0].t), comparar: COMPARAR }));
      } catch (e) {
        delete b.enRepaso;
        if (['sin_clave', 'limite', 'sin_sesion'].includes(e.code)) AI.stopped = e.message;
        else b.aiErr = e.message || 'Error';
      } finally {
        AI.busy.delete(b);
        try { refresh(b); updateAIBar(); } catch (e) { console.error(e); }
      }
    }
  }));
  terminarRonda();
}
// Recalcula parecidas/repetidas y, si ya no queda nada identificándose, junta las del mismo avión
function terminarRonda() {
  try {
    const before = bursts.map(x => x.similar); markSimilar();
    new Set([...markDups(), ...bursts.filter((x, i) => x.similar !== before[i])]).forEach(refresh);
    renderStat(); updateSave(); updateAIBar();
  } catch (e) { console.error(e); }
  // Al terminar todo, las ráfagas del mismo avión se juntan solas (se pueden volver a separar)
  if (!AI.busy.size) { const n = unirRepetidas(); if (n) toast(`${n} ${n === 1 ? 'ráfaga repetida unida' : 'ráfagas repetidas unidas'} con su avión`); }
  // Tras unir, el avión puede tener ya mejor foto principal (o una segunda) que la que miró la IA: si no se leyó la
  // matrícula entera, se vuelve a leer UNA vez con la principal y la segunda nuevas (p. ej. EC-NOS en la toma
  // cercana, o la letra que tapaba el ala en otra toma).
  if (!AI.busy.size && aiOn() && !AI.stopped) {
    const repaso = bursts.filter(b => b.on && b.n && b.ai?.hay_avion && !b.ai.matricula && !b.repaso
      && (b.ai.para !== b.n || (b.x && b.ai.segunda !== b.x)));
    if (repaso.length) { repaso.forEach(b => { b.repaso = true; b.enRepaso = true; }); runAI(repaso); }
  }
  if (!AI.busy.size) { programarCruce(); programarDeteccion(); }
}
function refresh(b) { if (bursts.includes(b)) renderBurst(b); }
function renderStat() {
  const sim = bursts.filter(b => b.similar).length;
  $('#addStat').textContent = `${bursts.reduce((a, b) => a + b.frames.length, 0)} fotos · ${bursts.length} ráfagas · ${folder}`
    + (paresJpg ? ` · ${paresJpg} JPG de RAW+JPG contados una vez` : '') + (sim ? ` · ${sim} ${sim === 1 ? 'parece' : 'parecen'} el mismo avión que la anterior (revisa «Unir con la anterior»)` : '');
}
function applyAI(b, r) {
  // Segunda pasada tras unir (con la mejor foto y la segunda): si lee peor que la primera, se queda la primera
  const repaso = b.enRepaso; delete b.enRepaso;
  if (repaso && b.ai?.hay_avion && valorIA(r) < valorIA(b.ai)) { aplicarEntero(b, r); return; }
  b.ai = r;
  if (!r.hay_avion) { if (!b.touched.on) { b.on = false; b.offPor = 'ia'; } return; }
  // la web la había desmarcado (toma suelta), pero la IA ve un avión: se guarda (todo avión fotografiado cuenta)
  if (!b.on && b.offPor && b.offPor !== 'ia' && !b.touched.on) { b.on = true; b.offPor = ''; }
  aplicarEntero(b, r);
  const extra = [r.codigo, r.librea].filter(Boolean).join(' · ');
  const reg = r.matricula ? r.matricula + (extra ? `(${extra})` : '') : '';
  if (!b.touched.reg && reg) b.reg = reg;
  if (!b.touched.type && r.tipo_icao) b.type = r.tipo_icao;
  if (!b.touched.op && r.operador) b.op = r.operador;
}
// «¿Cortado?» lo calcula la web mirando los bordes y solo es una sospecha. La IA ve la foto de verdad y su respuesta
// manda en las tomas que mira (principal y adicionales). Una toma con sospecha cuyo avión no está más pegado a ese
// borde que en otra que la IA ve entera, también está entera. Si la IA ve cortada la principal, se elige otra.
const LADO = { l: 0, t: 1, r: 2, b: 3 };
function aplicarEntero(b, r) {
  if (!DETECTAR_CORTES) return;
  const v = r?.entero || {}; let cambio = false;
  for (const f of b.frames) {
    if (!(f.name in v)) continue;
    if (v[f.name] && !f.enteroIA) { f.enteroIA = true; f.cortadoIA = false; cambio = true; }
    else if (!v[f.name] && !f.cortadoIA) { f.cortadoIA = true; f.enteroIA = false; cambio = true; }
  }
  const enteras = b.frames.filter(f => f.enteroIA && f.box);
  for (const f of b.frames) {
    if (!f.touches || f.enteroIA || f.cortadoIA || !f.box || !f.lados) continue;
    const igualQueEntera = [...f.lados].every(l => enteras.some(o => {
      const i = LADO[l]; return l === 'l' || l === 't' ? f.box[i] >= o.box[i] - 0.01 : f.box[i] <= o.box[i] + 0.01;
    }));
    if (igualQueEntera) { f.enteroIA = true; cambio = true; }
  }
  if (!cambio) return;
  const n = b.n, x = b.x; pickBest(b);
  const pn = b.frames.find(f => f.name === n);
  if (pn && !pn.cortadoIA && !pn.obst) { b.n = n; b.x = x; }   // la principal elegida sigue valiendo: no se cambia
}
const byAI = (b, k) => (b.ai && !b.touched?.[k] && b[k] ? ' byai' : '');
function aiLine(b) {
  if (!aiOn() && !b.ai) return '';
  if (AI.busy.has(b)) return '<p class="ailine"><span class="spin" aria-hidden="true"></span> Identificando con IA…</p>';
  if (b.aiErr) return `<p class="ailine err">La IA falló: ${esc(b.aiErr)} <button class="btn sm ghost" data-act="ai">Reintentar</button></p>`;
  const r = b.ai;
  if (!r) return b.n ? `<p class="ailine">Sin identificar <button class="btn sm ghost" data-act="ai">Identificar con IA</button></p>` : '';
  if (!r.hay_avion) return `<p class="ailine err">La IA no ve ningún avión en la foto principal${b.on ? '' : ', así que no se guardará'}. <button class="btn sm ghost" data-act="ai">Volver a identificar</button></p>`;
  const what = (r.matricula || (r.matricula_parcial ? `parcial ${r.matricula_parcial}` : r.codigo ? 'serial no legible' : 'matrícula no legible')) + (r.codigo ? ` · código ${r.codigo}` : '');
  const stale = r.para && r.para !== b.n ? ' · <i>identificada con otra foto</i>' : '';
  const quien = r.modelo ? ` · ${esc(r.modelo)}${r.revisado ? ' (revisada)' : ''}` : '';
  return `<p class="ailine"><span class="conf ${r.confianza}">IA · ${r.confianza}${quien}</span><b>${esc(what)}</b><span>${esc([r.tipo_icao, r.operador, r.librea].filter(Boolean).join(' · '))}</span><span>— ${esc(r.motivo)}${stale}</span><button class="btn sm ghost" data-act="ai">Volver a identificar</button></p>${cmpLine(r)}`;
}
// Prueba: qué leyó cada modelo en la misma foto
function cmpEstado(r) {
  const c = r?.comparacion; if (!c) return null;
  const a = c[String(c.barato).toLowerCase()], g = c[String(c.grande).toLowerCase()];
  if (!a || !g) return null;
  if (a.error) return { igual: false, a, g, c };
  const leida = x => claveReg(x.matricula) || (x.matricula_parcial ? 'parcial ' + x.matricula_parcial : '—');
  return { igual: leida(a) === leida(g), a, g, c, leida };
}
function cmpLine(r) {
  const e = cmpEstado(r); if (!e) return '';
  const { a, g, c } = e;
  const txt = a.error ? `${c.barato} falló (${a.error})` : `${c.barato}: ${e.leida(a)} ${a.tipo_icao} (${a.confianza})${a.revisaria ? ', la habría mandado a revisar' : ''} · ${c.grande}: ${e.leida(g)} ${g.tipo_icao} (${g.confianza})`;
  return `<p class="ailine cmp ${e.igual ? 'ok' : 'err'}">Prueba ${e.igual ? '✓ misma matrícula' : '✗ distinta'} — ${esc(txt)}</p>`;
}
// Agrupa las ráfagas del MISMO avión en toda la carpeta (sin límite de día ni de hora). dupOf = id de la primera
// ráfaga de ese avión. Tres formas de reconocerlo, de más a menos segura:
//  1. misma matrícula (escrita o leída por la IA);
//  2. matrícula parcial (p. ej. «…2792» o «YV27?2») que encaja con UNA sola matrícula de la carpeta;
//  3. sin matrícula legible (de frente, de cola, toma suelta): el único avión compatible —mismo tipo y operador—
//     a menos de 10 min; o, si la IA no dijo nada, que esté entre dos ráfagas de ese mismo avión.
function markDups() {
  const prev = bursts.map(b => b.dupOf), changed = [];
  bursts.forEach(b => { b.dupOf = undefined; b.dupPor = ''; });
  // v0.4: solo dentro del mismo tramo (mismo día y aeropuerto): el mismo avión en otro aeropuerto es otra entrada
  const K = (b, reg) => (b.tramo ?? '') + '|' + reg;
  const raiz = new Map();   // tramo|matrícula → primera ráfaga con ella
  bursts.forEach(b => {
    const k = claveReg(b.reg); if (!k) return;
    if (raiz.has(K(b, k))) { b.dupOf = raiz.get(K(b, k)).id; b.dupPor = 'reg'; } else raiz.set(K(b, k), b);
  });
  bursts.forEach(b => {
    if (claveReg(b.reg)) return;
    const re = patronParcial(b.ai?.matricula_parcial); if (!re) return;
    const regs = [...raiz.keys()].filter(k => k.startsWith(K(b, '')) && re.test(k.slice(K(b, '').length)));
    if (regs.length === 1) { b.dupOf = raiz.get(regs[0]).id; b.dupPor = 'parcial'; }
  });
  // avión ya reconocido (por 1 o 2) de cada ráfaga
  const avion = new Map();
  bursts.forEach(b => { const k = claveReg(b.reg) ? K(b, claveReg(b.reg)) : b.dupPor === 'parcial' ? K(b, claveReg(bursts.find(x => x.id === b.dupOf)?.reg)) : ''; if (k) avion.set(b, k); });
  const ini = x => x.frames[0].t, fin = x => x.frames[x.frames.length - 1].t;
  const separacion = (x, y) => Math.max(0, ini(y) - fin(x), ini(x) - fin(y));
  const fam = t => claveReg(t).slice(0, 2);   // B732/B733 → B7 · LJ25/LJ35 → LJ (el tipo exacto lo da la ficha)
  const op = t => claveReg(t).replace(/LINEASAEREAS|AIRLINES|AIRWAYS|AVIATION|LATAM/g, '');
  const casa = (x, o) => (!x.type || !o.type || fam(x.type) === fam(o.type)) && (!x.op || !o.op || op(x.op).includes(op(o.op)) || op(o.op).includes(op(x.op)));
  const CERCA = 10 * 60 * 1000;
  bursts.forEach((b, i) => {
    if (avion.has(b) || b.ai?.hay_avion === false || patronParcial(b.ai?.matricula_parcial)) return;
    let k = '';
    if (b.type || b.op) {
      const regs = new Set(bursts.filter(o => avion.has(o) && o.tramo === b.tramo && separacion(b, o) < CERCA && casa(b, o)).map(o => avion.get(o)));
      if (regs.size === 1) k = [...regs][0];
    } else {
      const p = bursts[i - 1], n = bursts[i + 1];
      if (p && n && avion.get(p) && avion.get(p) === avion.get(n) && p.tramo === b.tramo && separacion(b, p) < CERCA && separacion(b, n) < CERCA) k = avion.get(p);
    }
    if (k) { b.dupOf = raiz.get(k).id; b.dupPor = 'cerca'; }
  });
  bursts.forEach((b, i) => { if (b.dupOf !== prev[i]) changed.push(b); });
  return changed;
}
// «…XI» → termina en XI · «D-AI?I» → D,A,I,cualquiera,I · «YV30» → contiene YV30 (mínimo 3 caracteres legibles)
function patronParcial(p) {
  const raw = String(p || '').toUpperCase().trim(); if (!raw) return null;
  const suf = /^(…|\.\.\.)/.test(raw);
  const core = raw.replace(/^(…|\.\.\.)/, '').replace(/[^A-Z0-9?]/g, '');
  if (core.replace(/\?/g, '').length < 3) return null;
  const body = core.replace(/\?/g, '[A-Z0-9]');
  return new RegExp(suf ? body + '$' : core.includes('?') ? '^' + body + '$' : body);
}
function dupBanner(b) {
  if (b.dupOf === undefined) return '';
  const t = bursts.find(x => x.id === b.dupOf); if (!t) return '';
  const por = b.dupPor === 'reg' ? 'Misma matrícula que' : b.dupPor === 'parcial' ? `La matrícula parcial encaja con ${esc(t.reg)}, de` : `Sin matrícula legible, pero el único avión compatible cerca es ${esc(t.reg)}, de`;
  return `<div class="similar dup"><span>${por} la ráfaga de las ${hhmm(t.frames[0].t)} (${esc(base(t.frames[0].name))}): es el mismo avión, seguramente en otra fase (rodando, despegando…).</span><button class="btn sm" data-act="mergedup">Unir con esa ráfaga</button></div>`;
}
function otherBanner(b) {
  const f = b.ai?.otro_avion_en?.[0];
  if (!f || b.ai.para !== b.n || !b.frames.some(x => x.name === f)) return '';
  return `<div class="similar other"><span>La IA ve otro avión en ${esc(base(f))}: puede que esta ráfaga tenga dos aviones. Busca en la tira dónde cambia y usa «Separar desde aquí».</span><button class="btn sm" data-act="aiview" data-f="${esc(f)}">Ver ${esc(base(f).slice(-4))}</button></div>`;
}
function updateAIBar() {
  if (!bursts.length) { $('#aiBar').hidden = true; return; }
  const ided = bursts.filter(b => b.ai).length, busy = AI.busy.size;
  const missing = bursts.filter(b => pendienteIA(b) && !AI.busy.has(b)).length;
  const dups = bursts.filter(b => b.dupOf !== undefined).length;
  const low = bursts.filter(b => b.on && b.ai && b.ai.hay_avion && (b.ai.confianza === 'baja' || !b.ai.matricula)).length;
  let t = !aiOn() && !ided ? 'Identificación con IA desactivada.'
    : busy ? `Identificando con IA… ${ided} hechas, ${busy + missing} por hacer`
    : `${ided} ${ided === 1 ? 'ráfaga identificada' : 'ráfagas identificadas'} con IA` + (low ? ` · ${low} con dudas (⚠ en la nota)` : '');
  if (AI.stopped) t = AI.stopped + (ided ? ` · ${ided} identificadas` : '');
  if (dups) t += ` · ${dups} ${dups === 1 ? 'ráfaga repite' : 'ráfagas repiten'} matrícula`;
  const cmps = bursts.map(b => cmpEstado(b.ai)).filter(Boolean);
  if (cmps.length) {
    const iguales = cmps.filter(e => e.igual).length, sinRev = cmps.filter(e => !e.a.error && !e.a.revisaria);
    const fallosSinRev = sinRev.filter(e => !e.igual).length;
    t += ` · Prueba ${cmps[0].c.barato} vs ${cmps[0].c.grande}: ${iguales} de ${cmps.length} matrículas iguales`
      + ` · ${cmps.length - sinRev.length} irían a revisión` + (fallosSinRev ? ` · ${fallosSinRev} distintas SIN revisión (estas son las que importan)` : ' · ningún fallo se habría colado');
  }
  $('#aiStat').textContent = t;
  const difs = cmps.filter(e => !e.igual).length;
  $('#cmpBtn').hidden = !difs; $('#cmpBtn').textContent = `Ver diferencias (${difs})`;
  $('#aiRunBtn').hidden = !aiOn() || busy > 0 || !missing;
  $('#aiRunBtn').textContent = `Identificar las que faltan (${missing})`;
  $('#dupBtn').hidden = !dups; $('#dupBtn').textContent = `Unir repetidas (${dups})`;
  $('#aiBar').hidden = false;
}
$('#aiRunBtn').onclick = () => runAI(null, true);
// Une en una sola todas las ráfagas de cada avión de la carpeta. Los grupos se calculan UNA vez antes de unir:
// si se recalculan tras cada unión, una ráfaga sin matrícula deja de estar «entre dos» y se queda fuera.
function unirRepetidas() {
  markDups();
  const pares = bursts.filter(b => b.dupOf !== undefined).map(b => [bursts.find(x => x.id === b.dupOf), b]).filter(([t]) => t);
  let n = 0;
  for (const [t, b] of pares.reverse()) {
    const i = bursts.indexOf(t), j = bursts.indexOf(b);
    if (i < 0 || j < 0 || i === j) continue;
    mergeBursts(i, j, true); n++;
  }
  if (n) { renumber(); markSimilar(); markDups(); renderAll(); updateSave(); updateAIBar(); }
  return n;
}
$('#dupBtn').onclick = () => { if (unirRepetidas()) toast('Ráfagas del mismo avión unidas'); };
// Salta a la siguiente ráfaga donde los dos modelos leyeron distinto
$('#cmpBtn').onclick = () => {
  const difs = bursts.filter(b => { const e = cmpEstado(b.ai); return e && !e.igual; });
  if (!difs.length) return;
  const y = window.scrollY + 120;
  const sig = difs.find(b => (document.getElementById('b' + b.id)?.getBoundingClientRect().top ?? 0) + window.scrollY > y) || difs[0];
  document.getElementById('b' + sig.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
/* ---------------- v0.4 · tramos: cada uno con su aeropuerto ---------------- */
// La carpeta se parte en tramos al cambiar de día o tras más de 2 h sin fotos (para cambiar de aeropuerto hay que volar
// o conducir). Cada tramo tiene su aeropuerto: escrito a mano en el tramo, el de la carpeta (por defecto) o detectado
// con las matrículas y el índice de escalas del ADS-B. Un tramo se puede partir («Otro aeropuerto desde aquí») o unir.
const HUECO_TRAMO = 2 * 3600000;
const ICAO = /^[A-Z0-9]{4}$/;
let tramos = [], tramoN = 0;
const tramoDe = b => tramos.find(t => t.id === b.tramo);
const aptDe = b => tramoDe(b)?.apt || '';
const aptCarpeta = () => { const a = $('#apt').value.trim().toUpperCase(); return ICAO.test(a) ? a : ''; };
const nuevoTramo = () => { const a = aptCarpeta(); return { id: tramoN++, apt: a, por: a ? 'carpeta' : '', det: null }; };
function calcularTramos() {
  tramos = []; let t = null, prev = 0;
  for (const b of bursts) {
    const ini = b.frames[0].t;
    if (!t || ymd(ini) !== ymd(prev) || ini - prev > HUECO_TRAMO) { t = nuevoTramo(); tramos.push(t); }
    b.tramo = t.id; prev = Math.max(prev, b.frames[b.frames.length - 1].t);
  }
}
// Tramos en el orden de la carpeta (por su primera ráfaga); los que se quedan sin ráfagas desaparecen
function ordenTramos() {
  const pos = new Map(); bursts.forEach((b, i) => { if (!pos.has(b.tramo)) pos.set(b.tramo, i); });
  return tramos.filter(t => pos.has(t.id)).sort((x, y) => pos.get(x.id) - pos.get(y.id));
}
function tramosCambiados() {
  tramos = ordenTramos(); renderAll(); updateSave(); DET.fase = 1; programarDeteccion(); if (adsbOn()) iniciarADSB();
}
function otroAeropuertoDesde(b) {
  const t = tramoDe(b), nt = { id: tramoN++, apt: '', por: '', det: null };
  bursts.slice(bursts.indexOf(b)).filter(x => x.tramo === t?.id).forEach(x => { x.tramo = nt.id; });
  tramos.push(nt); tramosCambiados();
  document.querySelector(`[data-tramo-apt="${nt.id}"]`)?.focus();
}
function unirTramoAnterior(id) {
  const ord = ordenTramos(), k = ord.findIndex(t => t.id === id); if (k <= 0) return;
  bursts.forEach(b => { if (b.tramo === id) b.tramo = ord[k - 1].id; });
  tramosCambiados();
}
function ponerAptTramo(id, valor) {
  const t = tramos.find(x => x.id === id); if (!t) return;
  const a = String(valor || '').trim().toUpperCase();
  if (ICAO.test(a)) { t.apt = a; t.por = 'mano'; }
  else { t.apt = aptCarpeta(); t.por = t.apt ? 'carpeta' : ''; if (t.det?.apt && !t.apt) { t.apt = t.det.apt; t.por = 'adsb'; } }
  pintarTramos(); bursts.filter(b => b.tramo === id).forEach(refresh); updateSave(); if (adsbOn()) iniciarADSB();
}
// El aeropuerto de la carpeta es el de los tramos que no tienen uno escrito a mano ni detectado
$('#apt').addEventListener('change', () => {
  const a = aptCarpeta();
  for (const t of tramos) if (t.por !== 'mano' && t.por !== 'adsb') { t.apt = a; t.por = a ? 'carpeta' : ''; }
  for (const t of tramos) if (!t.apt && t.det?.apt) { t.apt = t.det.apt; t.por = 'adsb'; }
  if (bursts.length) { renderAll(); updateSave(); if (adsbOn()) iniciarADSB(); }
});
const fechaHora = t => new Date(t).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + hhmm(t);
function cabeceraTramo(t, n) {
  const bs = bursts.filter(b => b.tramo === t.id); if (!bs.length) return '';
  const ini = bs[0].frames[0].t, fin = Math.max(...bs.map(b => b.frames[b.frames.length - 1].t));
  const d = t.det, txt = [];
  if (d?.apt) {
    const quien = `${d.apoyos} de ${d.total} ${d.total === 1 ? 'matrícula' : 'matrículas'}`;
    if (d.apt === t.apt && t.por === 'adsb') txt.push(`Detectado con el ADS-B: ${quien} estaba${d.apoyos === 1 ? '' : 'n'} en ${esc(d.apt)} a la hora de las fotos` + (d.claro ? '' : ` (también encaja ${esc(d.alternativa)}: compruébalo)`) + '.');
    else if (d.apt === t.apt) txt.push(`✓ El ADS-B lo confirma (${quien}).`);
    else txt.push(`⚠ El ADS-B lo sitúa en <b>${esc(d.apt)}</b> (${quien}). <button class="btn sm ghost" data-tact="usar" data-apt="${esc(d.apt)}">Usar ${esc(d.apt)}</button>`);
  } else if (t.por !== 'mano') {
    const e = DET.estadoTramo.get(t.id);
    if (e === 'buscando') txt.push('Buscando el aeropuerto con las matrículas…');
    else if (e === 'sin_regs') txt.push(t.apt ? '' : 'Para detectarlo hace falta alguna matrícula leída (o escríbelo).');
    else if (e === 'no') txt.push(t.apt ? '' : 'El ADS-B no sitúa estas matrículas a esa hora: escríbelo a mano.');
    else if (e === 'antiguo') txt.push(t.apt ? '' : 'No hay historial ADS-B de esa fecha (empieza el 10/03/2023): escríbelo a mano.');
    else if (e === 'reciente') txt.push(t.apt ? '' : 'El historial ADS-B de hoy aún no está publicado: escríbelo o vuelve mañana.');
  }
  if (!t.apt && !txt.length) txt.push(adsbOn() ? 'Se detectará con las matrículas (o escríbelo).' : 'Escribe el aeropuerto (código OACI).');
  return `<div class="tramo" id="t${t.id}" data-tramo="${t.id}">
    <span class="tt">Tramo ${n} · ${esc(fechaHora(ini))}–${esc(hhmm(fin))} · ${bs.length} ${bs.length === 1 ? 'ráfaga' : 'ráfagas'}</span>
    <label class="field">Aeropuerto <input type="text" class="icao${t.por === 'adsb' ? ' byadsb' : ''}" data-tramo-apt="${t.id}" value="${esc(t.apt)}" maxlength="4" placeholder="????" aria-label="Aeropuerto del tramo ${n}"></label>
    ${txt.length ? `<span class="tdet">${txt.join(' ')}</span>` : ''}
    ${n > 1 ? '<button class="btn sm ghost" data-tact="unir" title="Las ráfagas de este tramo pasan al anterior">Unir con el tramo anterior</button>' : ''}
  </div>`;
}
function pintarTramos() {
  ordenTramos().forEach((t, i) => { const el = document.getElementById('t' + t.id); if (el) el.outerHTML = cabeceraTramo(t, i + 1); });
}
$('#bursts').addEventListener('click', e => {
  const cab = e.target.closest('.tramo'); if (!cab) return;
  const id = +cab.dataset.tramo, a = e.target.closest('[data-tact]'); if (!a) return;
  if (a.dataset.tact === 'unir') unirTramoAnterior(id);
  else if (a.dataset.tact === 'usar') ponerAptTramo(id, a.dataset.apt);
});
$('#bursts').addEventListener('change', e => { const i = e.target.closest('[data-tramo-apt]'); if (i) ponerAptTramo(+i.dataset.tramoApt, i.value); });

/* ---------------- v0.4 · detección del aeropuerto (índice mundial de escalas) ---------------- */
// Con las matrículas de cada tramo (leídas por la IA o escritas) y la hora de la cámara, busca en qué aeropuerto
// estaban todas (js/escalas.js). Los días del índice (TODO) se piden como los del ADS-B: la primera vez se preparan
// en GitHub Actions (unos 3 min por día) y luego quedan para todos. Primero solo los días que cubren la hora de casa
// ± 3 h; si algún tramo no se encuentra, todo el rango (la cámara podía ir en la hora de otro país).
const DET = { fase: 1, timer: 0, estadoTramo: new Map(), corriendo: false, otraVez: false };
// Matrículas fiables para situar el tramo: escritas a mano o leídas enteras por la IA sin confianza baja
const regFiable = b => regPropia(b) && b.ai?.hay_avion !== false && (b.touched.reg || (claveReg(b.ai?.matricula) === claveReg(b.reg) && b.ai?.confianza !== 'baja'));
const horaFoto = b => paredDe((b.frames.find(f => f.name === b.n) || b.frames[0]).t);
function programarDeteccion() { clearTimeout(DET.timer); DET.timer = setTimeout(detectarAeropuertos, 600); }
async function detectarAeropuertos() {
  if (!adsbOn() || !bursts.length || !tramos.length) return;
  if (DET.corriendo) { DET.otraVez = true; return; }   // ya hay una en marcha: se repite al terminar
  DET.corriendo = true;
  try {
    const ts = ordenTramos().filter(t => t.por !== 'mano').map(t => ({ id: t.id, consultas: bursts.filter(b => b.tramo === t.id && b.n && regFiable(b)).map(b => ({ reg: claveReg(b.reg), pared: horaFoto(b) })) }));
    ts.forEach(t => DET.estadoTramo.set(t.id, t.consultas.length ? 'buscando' : 'sin_regs'));
    const conRegs = ts.filter(t => t.consultas.length);
    if (!conRegs.length) { pintarTramos(); pintarADSB(); return; }
    const paredes = conRegs.flatMap(t => t.consultas.map(c => c.pared));
    const c = desfaseCasa(paredes[0]);
    const hoy = new Date().toISOString().slice(0, 10);
    const todos = diasNecesarios(paredes, ...(DET.fase >= 2 ? [-720, 840] : [c - 180, c + 180]));
    const dias = todos.filter(f => f >= ADSB_DESDE && f < hoy);
    if (!dias.length) { conRegs.forEach(t => DET.estadoTramo.set(t.id, todos.every(f => f < ADSB_DESDE) ? 'antiguo' : 'reciente')); pintarTramos(); pintarADSB(); return; }
    const x = apEstado('TODO');
    const faltan = dias.filter(f => !x.fechas.includes(f));
    if (faltan.length) { await pedirADSB('TODO', { fechas: faltan }, true); await vigilarADSB(); }
    const indices = new Map(dias.filter(f => ADSB.docs.has(claveDia('TODO', f))).map(f => [f, ADSB.docs.get(claveDia('TODO', f))]));
    const esperando = dias.some(f => !ADSB.docs.has(claveDia('TODO', f)) && ESPERA.includes(x.estados[f]));
    if (!indices.size) { if (!esperando) conRegs.forEach(t => DET.estadoTramo.set(t.id, 'no')); pintarTramos(); pintarADSB(); return; }
    const res = detectar(conRegs, indices);
    let cambio = false; const hs = [];
    for (const t of conRegs) {
      const r = res.get(t.id), tr = tramos.find(z => z.id === t.id);
      if (!tr) continue;
      if (!r?.apt) { tr.det = null; DET.estadoTramo.set(t.id, esperando ? 'buscando' : 'no'); continue; }
      tr.det = r; DET.estadoTramo.set(t.id, 'ok'); hs.push(r.h);
      if ((tr.por === 'adsb' || !tr.por) && tr.apt !== r.apt) { tr.apt = r.apt; tr.por = 'adsb'; cambio = true; }
    }
    // desfase de la cámara (min por delante de UTC) más repetido entre los tramos encontrados: punto de partida del ADS-B
    const hAntes = ADSB.hDet;
    if (hs.length) ADSB.hDet = hs.sort((p, q) => hs.filter(v => v === q).length - hs.filter(v => v === p).length)[0];
    if (ADSB.hDet !== hAntes) programarCruce();   // la hora de la cámara de partida ha cambiado: se vuelve a cruzar
    // algún tramo sin encontrar con los días de la hora de casa: probar todo el rango (una vez)
    if (DET.fase < 2 && !esperando && conRegs.some(t => !res.get(t.id)?.apt)) { DET.fase = 2; programarDeteccion(); }
    pintarTramos();
    if (cambio) { bursts.forEach(refresh); updateSave(); }
    if (cambio || hs.length) iniciarADSB();
  } finally {
    DET.corriendo = false;
    if (DET.otraVez) { DET.otraVez = false; programarDeteccion(); }
  }
}

/* ---------------- v0.3 · cruce con ADS-B (v0.4: un aeropuerto por tramo) ---------------- */
// Los datos (adsb.lol) se piden al servidor por aeropuerto y día UTC. La primera vez, GitHub Actions tarda unos minutos
// por día en prepararlos; después quedan guardados para todos. El cruce se hace aquí, en el navegador (js/adsb.js).
// La hora de la cámara se calibra una vez para toda la carpeta, en UTC (la cámara no cambia de hora al volar).
const ADSB = { apts: new Map(), docs: new Map(), cal: null, manual: null, hDet: null, timer: 0, error: '' };
const apEstado = apt => { let x = ADSB.apts.get(apt); if (!x) ADSB.apts.set(apt, x = { fechas: [], estados: {}, mensajes: {}, pedido: 0, cargando: false, tz: '', datos: null, clave: '', error: '' }); return x; };
const ESPERA = ['pendiente', 'procesando'];
const ETIQUETA = { sin_datos: 'sin datos ADS-B', error: 'falló la preparación', aun_no: 'aún no publicado', fuera_de_rango: 'fuera del historial (desde el 10/03/2023 hasta ayer)', sin_clave: 'el ADS-B aún no está activado en el servidor' };
const adsbOn = () => $('#useADSB').checked;
try { const v = localStorage.getItem('bs-useADSB'); if (v !== null) $('#useADSB').checked = v === '1'; } catch { /* sin almacenamiento */ }
$('#useADSB').onchange = () => {
  try { localStorage.setItem('bs-useADSB', adsbOn() ? '1' : '0'); } catch { /* sin almacenamiento */ }
  if (adsbOn()) { iniciarADSB(); programarDeteccion(); }
  else { clearTimeout(ADSB.timer); bursts.forEach(quitarPropuesta); markDups(); renderAll(); updateSave(); pintarADSB(); }
};
$('#adsbDelta').addEventListener('change', e => {
  const v = e.target.value.trim(); ADSB.manual = v === '' || !Number.isFinite(+v) ? null : +v; cruzarADSB();
});
const claveDia = (apt, f) => apt + '|' + f;
const fmtDia = f => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
// Minutos que la cámara va por delante de UTC, si ya se sabe (calibrada con el ADS-B o detectada con las escalas)
const horaCamara = () => ADSB.cal?.calibrado ? -ADSB.cal.delta : ADSB.hDet;
// Días UTC de unas ráfagas con la cámara h minutos por delante de UTC (± 30 min)
function fechasDe(bs, h) {
  const out = new Set();
  for (const b of bs) for (const f of [b.frames[0], b.frames[b.frames.length - 1]]) {
    const u = paredDe(f.t) - h * 60000;
    out.add(new Date(u - 30 * 60000).toISOString().slice(0, 10)); out.add(new Date(u + 30 * 60000).toISOString().slice(0, 10));
  }
  return [...out].sort();
}

async function iniciarADSB() {
  clearTimeout(ADSB.timer);
  if (!adsbOn() || !bursts.length) { pintarADSB(); return; }
  ADSB.error = '';
  const porApt = new Map();
  for (const b of bursts) { const a = aptDe(b); if (a) (porApt.get(a) || porApt.set(a, []).get(a)).push(b); }
  if (!porApt.size) { pintarADSB(); vigilarADSB(); return; }
  programarCruce();   // con los datos que ya haya (p. ej. al cambiar el aeropuerto de un tramo a uno ya descargado)
  const h = horaCamara();
  for (const [apt, bs] of porApt) {
    const x = apEstado(apt);
    // sin saber la hora de la cámara se supone la local del aeropuerto (el servidor la pasa a UTC)
    if (h == null) await pedirADSB(apt, { rangos: rangosCamara(bs) }, true);
    else { const fs = fechasDe(bs, h).filter(f => !x.fechas.includes(f)); if (fs.length) await pedirADSB(apt, { fechas: fs }, true); }
  }
  vigilarADSB();
}
async function pedirADSB(apt, cuerpo, sinVigilar) {
  const { data } = await sb.auth.getSession(); const tk = data.session?.access_token;
  if (!tk) { ADSB.error = 'vuelve a entrar en la web para usar el ADS-B.'; pintarADSB(); return; }
  const x = apEstado(apt);
  x.pedido = Date.now(); x.cargando = true; x.error = ''; pintarADSB();
  try {
    const r = await fetch('/api/adsb', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: JSON.stringify({ aeropuerto: apt, ...cuerpo }) });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`el servidor respondió ${r.status}`);
    if (j.tz) x.tz = j.tz;
    x.fechas = [...new Set([...x.fechas, ...(j.fechas || [])])].sort();
    Object.assign(x.estados, j.estados || {}); Object.assign(x.mensajes, j.mensajes || {});
    if (!r.ok) x.error = j.mensaje || `error ${r.status}`;
  } catch (e) { x.error = 'no se pudo pedir el ADS-B: ' + e.message; }
  finally { x.cargando = false; }
  if (!sinVigilar) vigilarADSB();
}
// Mira en Supabase cómo van los días pedidos (de cada aeropuerto y del índice de escalas), descarga los que ya están
// y vuelve a mirar cada 20 s mientras falte alguno
async function vigilarADSB() {
  clearTimeout(ADSB.timer);
  let escalasNuevas = false, datosNuevos = false;
  for (const [apt, x] of ADSB.apts) {
    const faltan = x.fechas.filter(f => !ADSB.docs.has(claveDia(apt, f)) && (ESPERA.includes(x.estados[f]) || x.estados[f] === 'listo'));
    if (!faltan.length) continue;
    const { data } = await sb.from('adsb_dias').select('fecha,estado,ruta,mensaje').eq('aeropuerto', apt).in('fecha', faltan);
    for (const row of data || []) {
      x.estados[row.fecha] = row.estado; x.mensajes[row.fecha] = row.mensaje || '';
      if (row.estado === 'listo' && row.ruta) {
        try {
          ADSB.docs.set(claveDia(apt, row.fecha), await descargarDia(`${SUPABASE_URL}/storage/v1/object/public/adsb/${row.ruta}`));
          if (apt === 'TODO') escalasNuevas = true;
        } catch (e) { x.estados[row.fecha] = 'error'; x.mensajes[row.fecha] = 'no se pudo descargar: ' + e.message; }
      }
    }
  }
  for (const [apt, x] of ADSB.apts) {
    if (apt === 'TODO') continue;
    const docs = x.fechas.map(f => ADSB.docs.get(claveDia(apt, f))).filter(Boolean);
    const clave = docs.map(d => d.fecha).join(',');
    if (docs.length && clave !== x.clave) { x.clave = clave; x.datos = juntarDias(docs); x.tz ||= x.datos.apt?.tz || ''; datosNuevos = true; }
  }
  if (escalasNuevas) programarDeteccion();
  if (datosNuevos) cruzarADSB();
  let esperando = false;
  for (const [apt, x] of ADSB.apts) {
    if (!x.fechas.some(f => !ADSB.docs.has(claveDia(apt, f)) && ESPERA.includes(x.estados[f]))) continue;
    esperando = true;
    // si un día lleva mucho en cola (p. ej. el procesado se cortó), se vuelve a pedir: el servidor lo relanza
    if (Date.now() - x.pedido > 22 * 60000) await pedirADSB(apt, { fechas: x.fechas.filter(f => !ADSB.docs.has(claveDia(apt, f))) }, true);
  }
  clearTimeout(ADSB.timer);
  if (esperando) ADSB.timer = setTimeout(vigilarADSB, 20000);
  pintarADSB(); pintarTramos();
}

let cruceT = 0;
function programarCruce() { clearTimeout(cruceT); cruceT = setTimeout(cruzarADSB, 400); }
const datosDe = b => { const x = ADSB.apts.get(aptDe(b)); return x?.datos?.aviones.length ? x.datos : null; };
// Calibra la hora de la cámara con las matrículas ya conocidas (de todos los aeropuertos) y mira qué dice el ADS-B de
// cada ráfaga con los datos de SU aeropuerto
function cruzarADSB() {
  const conDatos = [...ADSB.apts].filter(([a, x]) => a !== 'TODO' && x.datos?.aviones.length);
  if (!adsbOn() || !conDatos.length || !bursts.length) { pintarADSB(); return; }
  const an = conDatos.flatMap(([apt, x]) => anclas(bursts.filter(b => aptDe(b) === apt), x.datos));
  // referencia: la hora local del primer aeropuerto con datos (lo que se muestra y lo que se escribe a mano)
  const [refApt, refX] = conDatos[0], p0 = an[0]?.pared ?? paredDe(bursts[0].frames[0].t);
  const offRef = desfaseZona(refX.tz, p0) ?? 0;
  const ref = ADSB.hDet != null ? -ADSB.hDet : -offRef;
  const cal = ADSB.cal = calibrar(an, 'UTC', ADSB.manual == null ? null : ADSB.manual - offRef, ref);
  Object.assign(cal, { offRef, refApt });
  // con el desfase calculado, ¿hacen falta otros días UTC? (p. ej. la cámara iba en la hora de otro país)
  if (cal.calibrado || ADSB.hDet != null) {
    for (const [apt, x] of conDatos) {
      const extra = fechasUtc(bursts.filter(b => aptDe(b) === apt), 'UTC', cal.delta).filter(f => !x.fechas.includes(f));
      if (extra.length) pedirADSB(apt, { fechas: extra });
    }
  }
  if (reagruparADSB()) return;   // ha juntado o separado ráfagas: el cruce se repite con las nuevas
  let cambios = 0;
  for (const b of bursts) {
    const antes = JSON.stringify(b.adsb || null) + b.reg + b.type, datos = datosDe(b);
    if (!datos || !b.n || b.ai?.hay_avion === false) { quitarPropuesta(b); b.adsb = null; }
    else {
      const r = decidir(b, candidatos(b, datos, cal, 'UTC'), datos);
      b.adsb = { ...resumir(r, b, 'UTC', cal, datos.apt?.tz || 'UTC'), apt: datos.apt?.icao || '' };
      if (r.estado === 'propuesta') proponer(b, r.c); else if (!regPropia(b)) quitarPropuesta(b);
      else tipoDeADSB(b, r);
    }
    if (antes !== JSON.stringify(b.adsb || null) + b.reg + b.type) { cambios++; refresh(b); }
  }
  if (cambios) {
    markSimilar(); markDups();
    // las ráfagas del mismo avión (ahora con matrícula) se juntan solas, como con la IA
    const n = AI.busy.size ? 0 : unirRepetidas();
    if (n) { toast(`${n} ${n === 1 ? 'ráfaga unida' : 'ráfagas unidas'} con su avión gracias al ADS-B`); programarCruce(); }
    else renderAll();
    updateSave(); updateAIBar();
  }
  pintarADSB();
}
// v0.4.1 · Corrige el primer corte de ráfagas (8 s sin fotos) con el ADS-B, cuando la cámara ya está en hora (hacen
// falta 2 aviones identificados): sabe qué avión pasaba por delante en cada momento (js/adsb.js · delanteEn).
//  · Separa una ráfaga si dos trozos seguidos (con ≥ 3 s sin fotos entre medias) tienen delante aviones distintos.
//  · Junta dos ráfagas seguidas del mismo tramo (< 3 min) si delante pasaba el mismo avión y sus matrículas, si las
//    hay, son las de ese avión.
// Lo que decides tú manda: no separa las que uniste a mano ni junta las que separaste a mano. Espera a que la IA
// termine la ronda (no cambia ráfagas que se están identificando).
const principalDe = b => b.frames.find(f => f.name === b.n) || b.frames[0];
function reagruparADSB() {
  const cal = ADSB.cal;
  if (!cal?.calibrado || AI.busy.size || !adsbOn()) return 0;
  const utc = t => paredDe(t) + cal.delta * 60000, nuevas = [];
  let cambios = 0;
  for (let i = 0; i < bursts.length; i++) {
    const b = bursts[i], datos = datosDe(b);
    if (!datos || b.frames.length < 2 || b.touched.reg || b.sinCortesADSB || b.ai?.hay_avion === false) continue;
    const trozos = [[b.frames[0]]];
    for (let k = 1; k < b.frames.length; k++) { if (b.frames[k].t - b.frames[k - 1].t >= 3000) trozos.push([]); trozos[trozos.length - 1].push(b.frames[k]); }
    if (trozos.length < 2) continue;
    const quien = trozos.map(tr => delanteEn(datos, cal, utc(tr[tr.length >> 1].t)));
    // si la ráfaga ya está identificada, uno de los trozos tiene que ser ese avión (si no, «delante» no es fiable aquí)
    const suya = claveReg(b.reg);
    if (suya && !quien.some(q => q?.reg === suya)) continue;
    const k = quien.findIndex((q, j) => j > 0 && q && quien[j - 1] && q.reg !== quien[j - 1].reg);
    if (k > 0) { nuevas.push(...splitAt(i, trozos[k][0].name, { delante: quien[k].matricula })); cambios++; }
  }
  for (let i = bursts.length - 1; i > 0; i--) {
    const p = bursts[i - 1], b = bursts[i], datos = datosDe(b);
    if (!datos || datosDe(p) !== datos || b.mano || b.auto === 'adsb' || b.tramo !== p.tramo) continue;
    if (b.frames[0].t - p.frames[p.frames.length - 1].t > 3 * 60000 || p.ai?.hay_avion === false || b.ai?.hay_avion === false) continue;
    const qp = delanteEn(datos, cal, utc(principalDe(p).t)), qb = delanteEn(datos, cal, utc(principalDe(b).t));
    if (!qp || !qb || qp.reg !== qb.reg) continue;
    const kp = claveReg(p.reg), kb = claveReg(b.reg);
    if ((kp && kp !== qp.reg) || (kb && kb !== qp.reg)) continue;
    // y el tipo que ve la IA, si lo dice, el de ese avión (si no, quizá fotografiaba otro, p. ej. uno aparcado)
    const tipoOk = x => { const t = x.ai?.tipo_icao || (x.touched.type ? x.type : ''); return !t || !qp.tipo || familia(t) === familia(qp.tipo); };
    if (!tipoOk(p) || !tipoOk(b)) continue;
    mergeBursts(i - 1, i, true); cambios++;
  }
  if (!cambios) return 0;
  renumber(); markSimilar(); markDups(); renderAll(); updateSave(); updateAIBar();
  toast(`ADS-B: ${cambios} ${cambios === 1 ? 'ráfaga corregida' : 'ráfagas corregidas'} (mismo avión juntado o dos aviones separados)`);
  const pend = nuevas.filter(b => bursts.includes(b));
  if (pend.length && aiOn()) runAI(pend);
  programarCruce();
  return cambios;
}

// Matrícula propuesta por el ADS-B: se escribe en el campo (con borde discontinuo) mientras no la cambies tú
function proponer(b, c) {
  if (b.touched.reg || (b.reg && b.reg !== b.regAdsb)) return;
  b.reg = c.reg; b.regAdsb = c.reg;
  if (!b.touched.type && c.tipo && (!b.type || b.type === b.tipoAdsb || familia(b.type) === familia(c.tipo))) { b.type = c.tipo; b.tipoAdsb = c.tipo; }
}
// La matrícula está en el ADS-B a la hora de la foto: su tipo (de la base de datos de adsb.lol) manda sobre el que
// dedujo la IA mirando la foto, salvo que lo hayas escrito tú. Si deja de estar confirmada, vuelve el de la IA.
function tipoDeADSB(b, r) {
  if (b.touched.type) return;
  const t = r.estado === 'confirmada' ? r.c?.tipo : '';
  if (t) { if (b.type !== t) { b.type = t; b.tipoAdsb = t; } }
  else if (b.tipoAdsb && b.type === b.tipoAdsb) { b.type = b.ai?.tipo_icao || ''; b.tipoAdsb = ''; }
}
function quitarPropuesta(b) {
  if (b.regAdsb && b.reg === b.regAdsb && !b.touched.reg) b.reg = '';
  if (b.tipoAdsb && b.type === b.tipoAdsb && !b.touched.type) b.type = b.ai?.tipo_icao || '';
  b.regAdsb = ''; b.tipoAdsb = '';
}
function usarADSB(b, reg, tipo) {
  b.reg = reg; b.touched.reg = true; b.regAdsb = '';
  if (tipo && !b.touched.type) { b.type = tipo; b.tipoAdsb = ''; }
  markSimilar(); markDups(); renderAll(); updateSave(); updateAIBar(); programarCruce();
}
const byADSB = (b, k) => (k === 'reg' ? b.regAdsb && b.reg === b.regAdsb : b.tipoAdsb && b.type === b.tipoAdsb) && !b.touched?.[k] ? ' byadsb' : '';
const descADSB = c => [c.tipo, c.cs, c.fase].filter(Boolean).map(esc).join(' · ');
const botonADSB = (c, usar) => `<button class="btn sm ghost" data-act="adsbusar" data-reg="${esc(c.reg)}" data-tipo="${esc(c.tipo)}" title="Usar esta matrícula">${usar ? 'Usar ' : ''}${esc(c.reg)} <small>${descADSB(c)}</small></button>`;
function adsbLine(b) {
  const a = adsbOn() && b.adsb; if (!a) return '';
  const tag = '<span class="tag">ADS-B</span>';
  switch (a.estado) {
    case 'confirmada': return `<p class="adsbline ok">${tag}<span>✓ <b>${esc(a.reg)}</b> ${descADSB(a)} a las ${esc(a.hora)}</span></p>`;
    case 'propuesta': return b.regAdsb && b.reg === b.regAdsb
      ? `<p class="adsbline prop">${tag}<span>Matrícula propuesta: <b>${esc(a.reg)}</b> ${descADSB(a)} a las ${esc(a.hora)} — el único avión a esa hora que encaja ${a.por === 'parcial' ? 'con la matrícula parcial' : 'con el tipo'}. Compruébala.</span></p>` : '';
    case 'corregir': return `<p class="adsbline warn">${tag}<span>⚠ A esa hora no consta ${esc(b.reg)}, pero sí <b>${esc(a.reg)}</b> (${descADSB(a)}): ¿la IA leyó mal una letra?</span>${botonADSB(a, true)}</p>`;
    case 'otra_hora': return `<p class="adsbline warn">${tag}<span>${esc(a.reg)} estuvo en ${esc(a.apt)} ese día (a las ${esc(a.hora)}), pero no a la hora de esta foto: revisa la matrícula.</span></p>`;
    case 'no_consta': return `<p class="adsbline">${tag}<span>${esc(b.reg)} no aparece en el ADS-B de ese día (puede que no emita o que no haya cobertura).</span>${(a.top || []).map(c => botonADSB(c)).join('')}</p>`;
    case 'candidatos': return a.top?.length ? `<p class="adsbline">${tag}<span>A esa hora:</span>${a.top.map(c => botonADSB(c)).join('')}</p>` : '';
    default: return '';
  }
}
// Hora de la cámara respecto a la hora local del aeropuerto de referencia (el primero con datos)
function relojCamara(cal) {
  const dl = Math.round(cal.delta + (cal.offRef || 0)), d = Math.abs(dl), donde = cal.refApt ? ` de ${cal.refApt}` : '';
  const txt = d >= 60 ? `${Math.floor(d / 60)} h${d % 60 ? ' ' + (d % 60) + ' min' : ''}` : `${d} min`;
  const desfase = !d ? `en la hora local${donde}` : `${txt} ${dl < 0 ? 'adelantada' : 'atrasada'} respecto a la hora local${donde}`;
  if (cal.manual) return `hora de la cámara corregida a mano (${dl > 0 ? '+' : ''}${dl} min sobre la hora local${donde})`;
  if (!cal.calibrado) return ADSB.hDet != null ? `la cámara iba ${desfase} (según las escalas; con 2 aviones identificados se afina)`
    : 'hora de la cámara sin comprobar (hacen falta 2 aviones con matrícula, leída o escrita): se usa la hora local del aeropuerto';
  return `la cámara iba ${desfase} (calculado con ${cal.n} aviones; ya está corregido)`;
}
// Estado de la detección de aeropuertos para la barra del ADS-B
function textoDeteccion() {
  const x = ADSB.apts.get('TODO'), ts = ordenTramos().filter(t => t.por !== 'mano');
  if (!ts.length) return '';
  const esperan = x ? x.fechas.filter(f => !ADSB.docs.has(claveDia('TODO', f)) && ESPERA.includes(x.estados[f])) : [];
  const malos = x ? x.fechas.filter(f => !ESPERA.includes(x.estados[f]) && x.estados[f] && x.estados[f] !== 'listo') : [];
  const ok = ts.filter(t => t.det?.apt).length;
  const p = [];
  if (esperan.length) p.push(`preparando el índice de escalas del ${esperan.map(fmtDia).join(', ')} (unos 3 min por día la primera vez)`);
  if (ok) p.push(`${ok} de ${ts.length} ${ts.length === 1 ? 'tramo situado' : 'tramos situados'} por sus matrículas`);
  for (const f of malos) p.push(`escalas ${fmtDia(f)}: ${x.mensajes[f] || ETIQUETA[x.estados[f]] || x.estados[f]}`);
  if (x?.error) p.push(x.error);
  return p.length ? 'Aeropuertos: ' + p.join(', ') : '';
}
function pintarADSB() {
  const bar = $('#adsbBar');
  if (!adsbOn() || !bursts.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const partes = [], det = textoDeteccion();
  if (det) partes.push(det);
  for (const [apt, x] of ADSB.apts) {
    if (apt === 'TODO') continue;
    const p = [], esperan = x.fechas.filter(f => !ADSB.docs.has(claveDia(apt, f)) && ESPERA.includes(x.estados[f]));
    if (x.cargando && !x.fechas.length) p.push('pidiendo los datos…');
    if (esperan.length) p.push(`preparando ${esperan.map(fmtDia).join(', ')} (la primera vez tarda unos 5 min por día; después queda guardado)`);
    if (x.datos) p.push(`${x.datos.aviones.length} aviones en ${x.datos.fechas.map(fmtDia).join(', ')}`);
    for (const f of x.fechas) if (!ESPERA.includes(x.estados[f]) && x.estados[f] !== 'listo' && x.estados[f]) p.push(`${fmtDia(f)}: ${x.mensajes[f] || ETIQUETA[x.estados[f]] || x.estados[f]}`);
    if (x.error) p.push(x.error);
    if (bursts.some(b => aptDe(b) === apt)) partes.push(`${apt}: ${p.join(' · ') || '…'}`);
  }
  if (ADSB.cal) {
    const n = {}; bursts.forEach(b => { if (b.adsb) n[b.adsb.estado] = (n[b.adsb.estado] || 0) + 1; });
    const props = bursts.filter(b => b.adsb?.estado === 'propuesta' && b.regAdsb && b.reg === b.regAdsb).length;
    partes.push(relojCamara(ADSB.cal),
      [n.confirmada && `${n.confirmada} confirmadas`, props && `${props} propuestas`, n.corregir && `${n.corregir} posibles errores de lectura`,
        (n.otra_hora || n.no_consta) && `${(n.otra_hora || 0) + (n.no_consta || 0)} sin rastro a esa hora`, n.candidatos && `${n.candidatos} con candidatos para elegir`].filter(Boolean).join(', ') || 'sin coincidencias');
  }
  if (!tramos.some(t => t.apt) && !ADSB.apts.get('TODO')?.fechas.length) partes.push('escribe el aeropuerto o espera a que la IA lea alguna matrícula para detectarlo');
  if (ADSB.error) partes.push(ADSB.error);
  $('#adsbStat').textContent = 'ADS-B · ' + (partes.join(' · ') || '…');
  const inp = $('#adsbDelta');
  if (document.activeElement !== inp) inp.value = ADSB.manual != null ? ADSB.manual : '';
  inp.placeholder = ADSB.cal && !ADSB.cal.manual ? String(Math.round(ADSB.cal.delta + (ADSB.cal.offRef || 0))) : 'auto';
}

function notaDe(b) {
  const r = b.ai, rev = [];
  if (b.warn) rev.push(b.warn);
  if (r && r.hay_avion) {
    if (!r.matricula) rev.push(r.matricula_parcial ? 'matrícula parcial ' + r.matricula_parcial : r.codigo ? 'serial no legible (código ' + r.codigo + ')' : 'matrícula no legible');
    if (r.confianza === 'baja') rev.push('IA con confianza baja');
    if (r.matricula && r.verificado !== true) rev.push('tipo sin verificar con la ficha de la matrícula' + (r.fallo_ficha ? ` (${r.fallo_ficha})` : ''));
    if (r.tipo_dudoso) rev.push('el tipo ICAO no cuadra con el avión que describe la IA');
    if (r.otro_avion_en?.length) rev.push('puede haber otro avión en la ráfaga');
    if (r.para && r.para !== b.n) rev.push('la IA miró otra foto de la ráfaga');
    if (b.touched.reg && r.matricula && claveReg(r.matricula) !== claveReg(b.reg)) rev.push('la IA leyó ' + r.matricula);
  }
  const a = adsbOn() ? b.adsb : null;
  if (a?.estado === 'propuesta' && b.regAdsb && b.reg === b.regAdsb) rev.push(`matrícula propuesta por el ADS-B (${a.fase} a las ${a.hora}), no leída en la foto`);
  else if (a?.estado === 'corregir') rev.push(`ADS-B: a esa hora estaba ${a.reg}, no ${b.reg}`);
  else if (a?.estado === 'otra_hora') rev.push(`ADS-B: ${a.reg} estuvo ese día a las ${a.hora}, no a la hora de la foto`);
  else if (a?.estado === 'no_consta') rev.push('la matrícula no aparece en el ADS-B ese día');
  const t = tramoDe(b);
  if (!aptDe(b)) rev.push('sin aeropuerto');
  else if (t?.det?.apt && t.det.apt !== t.apt) rev.push(`el ADS-B sitúa las matrículas de este tramo en ${t.det.apt}, no en ${t.apt}`);
  const aptTxt = t?.por === 'adsb' && t.det?.apt === t.apt ? `Aeropuerto detectado por las escalas (adsb.lol): ${t.det.apoyos} de ${t.det.total} matrículas` : '';
  const adsbTxt = a?.estado === 'confirmada' ? `✓ ADS-B (adsb.lol): ${a.fase} a las ${a.hora}` : '';
  return [rev.length ? '⚠ Revisar: ' + rev.join('; ') : '', aptTxt, adsbTxt, r ? `IA (${r.confianza}): ${r.motivo}` : ''].filter(Boolean).join(' · ');
}

function updateSave() { const n = bursts.filter(b => b.on && b.n).length, off = bursts.filter(b => !b.on).length; $('#saveStat').textContent = `${n} ráfagas se guardarán como pendientes en «${folder}»` + (off ? ` · ${off} desmarcadas` : ''); $('#saveBtn').disabled = !n; }
$('#saveBtn').onclick = async () => {
  const todo = bursts.filter(b => b.on && b.n && !b.saved);
  $('#saveBtn').disabled = true; let ok = 0, fail = 0;
  for (const b of todo) {
    const nF = b.frames.find(f => f.name === b.n);
    let thumb_path = null;
    if (nF?.keepBlob) {
      thumb_path = `${user.id}/${uid()}.jpg`;
      const up = await sb.storage.from('thumbs').upload(thumb_path, nF.keepBlob, { contentType: 'image/jpeg' });
      if (up.error) thumb_path = null;
    }
    const row = { fecha: ymd(b.frames[0].t), matricula: b.reg, tipo: b.type, operador: b.op, aeropuerto: aptDe(b), carpeta: folder, archivo: base(b.n), archivo2: b.x ? base(b.x) : '', nota: notaDe(b), pendiente: true, thumb_path };
    if (b.ai || b.adsb) row.ia = { ...(b.ai || {}), otras_tomas: undefined, otro_avion_en: undefined, adsb: (adsbOn() && b.adsb) || undefined };
    let { data, error } = await sb.from('entries').insert(row).select().single();
    if (error && row.ia && /\bia\b/.test(error.message)) { delete row.ia; ({ data, error } = await sb.from('entries').insert(row).select().single()); }
    if (error) { fail++; continue; }
    b.saved = true; ok++; S.entries.unshift(data);
    $('#saveStat').textContent = `Guardando ${ok}/${todo.length}…`;
  }
  $('#saveStat').textContent = fail ? `${ok} guardadas · ${fail} con error (vuelve a pulsar para reintentar)` : `${ok} ráfagas guardadas como pendientes`;
  $('#saveBtn').disabled = !fail;
  S.entries.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  renderLog(); loadThumbs(); if (!fail) toast('Guardado en la bitácora');
};

boot();
