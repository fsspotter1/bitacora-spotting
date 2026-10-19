import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { RAW_RE, readFrame, captureTime, analyse, pickBest, sceneDiff, splitByAircraft, DETECTAR_CORTES } from './raw.js';
import { loadDetector, loadEmbedder } from './detect.js';
import { identificar, claveReg, fichasDeBitacora } from './ia.js';

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
let bursts = [], folder = '';
$('#pickBtn').onclick = () => { loadDetector(); loadEmbedder(); $('#pick').click(); };
$('#pick').onchange = async ev => {
  const files = [...ev.target.files].filter(f => RAW_RE.test(f.name) && !f.name.startsWith('.'));
  ev.target.value = '';
  if (!files.length) { $('#addStat').textContent = 'No hay RAW en esa carpeta.'; return; }
  folder = (files[0].webkitRelativePath || '').split('/')[0] || '';
  bursts = []; $('#bursts').innerHTML = ''; $('#saveBar').hidden = true; $('#aiBar').hidden = true; $('#pickBtn').disabled = true; AI.stopped = '';
  const total = files.length; let done = 0; const frames = [];
  const prog = t => { $('#bar').style.width = (100 * done / total) + '%'; $('#addStat').textContent = t; };
  for (const f of files) {
    try { const r = await readFrame(f); frames.push({ name: f.name, blob: r.blob, t: captureTime(r.date, f) }); }
    catch { frames.push({ name: f.name, t: f.lastModified, err: true }); }
    if (++done % 20 === 0) prog(`Leyendo ${done}/${total}`);
  }
  frames.sort((a, b) => a.t - b.t || a.name.localeCompare(b.name));
  const gap = (+$('#gap').value || 8) * 1000; let cur = [];
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
      const nbs = parts.map((fr, k) => k ? { frames: fr, reg: '', type: '', op: '', on: true, auto: true, touched: {} } : Object.assign(b, { frames: fr }));
      bursts.splice(bi, 1, ...nbs); renumber(); splits += parts.length - 1;
      nbs.forEach(x => { pickBest(x); if (x.loose) x.on = false; });
      bi += nbs.length - 1; $('#bursts').innerHTML = ''; bursts.slice(0, bi + 1).forEach(renderBurst);
    } else { pickBest(b); if (b.loose) b.on = false; renderBurst(b); }
    prog(`Analizando ${done}/${total} · ráfaga ${bi + 1}/${bursts.length}` + (splits ? ` · ${splits} separadas por cambio de avión` : ''));
  }
  markSimilar(); renderAll();
  $('#bar').style.width = '100%';
  $('#pickBtn').disabled = false; $('#saveBar').hidden = false; updateSave();
  AI.stopped = ''; updateAIBar();
  if (aiOn()) runAI();
};
function renumber() { bursts.forEach((b, i) => b.id = i); }
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
  $('#bursts').innerHTML = ''; bursts.forEach(renderBurst); renderStat();
}
function mergeWithPrev(i) { mergeBursts(i - 1, i); }
const RANGO = { alta: 3, media: 2, baja: 1 };
const valorIA = a => a ? (a.matricula ? 10 : 0) + (a.matricula_parcial ? 2 : 0) + (a.verificado ? 5 : 0) + (RANGO[a.confianza] || 0) : -1;
// Une la ráfaga j con la i (no hace falta que sean seguidas: p. ej. el que rodaba, uno que aterriza y otra vez el que rodaba)
function mergeBursts(i, j, quiet) {
  const p = bursts[i], b = bursts[j]; if (!p || !b || p === b) return;
  p.frames = p.frames.concat(b.frames).sort((x, y) => x.t - y.t || x.name.localeCompare(y.name));
  ['reg', 'type', 'op'].forEach(k => { if (!p[k] && b[k]) { p[k] = b[k]; if (b.touched?.[k]) p.touched[k] = true; } });
  if (b.ai && valorIA(b.ai) > valorIA(p.ai)) p.ai = b.ai;
  p.on = p.on || b.on;
  bursts.splice(j, 1); delete b.auto; pickBest(p); delete p.view; renumber(); markSimilar(); markDups();
  if (quiet) return;
  renderAll(); updateSave(); updateAIBar();
  document.getElementById('b' + p.id)?.scrollIntoView({ block: 'nearest' });
}
function splitAt(i, name) {
  const b = bursts[i]; const k = b.frames.findIndex(f => f.name === name); if (k <= 0) return;
  const nb = { frames: b.frames.slice(k), reg: '', type: '', op: '', on: true, auto: false, touched: {} };
  // la identificación era de la ráfaga entera: se repite para las dos partes
  b.ai = null; b.aiErr = ''; ['reg', 'type', 'op'].forEach(kk => { if (!b.touched?.[kk]) b[kk] = ''; });
  b.frames = b.frames.slice(0, k); pickBest(b); pickBest(nb); delete b.view;
  bursts.splice(i + 1, 0, nb); renumber(); markSimilar(); markDups(); renderAll(); updateSave();
  if (aiOn()) runAI([b, nb]);
}
const hm = t => new Date(t).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
      ${b.auto ? '<div class="similar"><span>Separada automáticamente: parece otro avión que la ráfaga anterior.</span><button class="btn sm" data-act="merge">Es el mismo: unir</button></div>' : ''}
      ${b.loose && !b.on ? '<p class="warnline">Toma suelta: parece un disparo sin finalidad o el inicio de una ráfaga. No se guardará salvo que marques «Guardar».</p>' : b.warn ? `<p class="warnline">⚠ ${esc(b.warn)}: revisa la ráfaga.</p>` : ''}
      <div class="row"><span class="time">${hm(b.frames[0].t)}</span><span class="files">${esc(base(b.frames[0].name))} – ${esc(base(b.frames[k - 1].name))} · ${k} ${k === 1 ? 'foto' : 'fotos'}</span>
        ${b.id > 0 && !b.similar && !b.auto ? '<button class="btn sm ghost" data-act="merge">Unir con la anterior</button>' : ''}</div>
      ${dupBanner(b)}${otherBanner(b)}
      <div class="inputs">
        <input type="text" class="reg${byAI(b, 'reg')}" data-k="reg" placeholder="Matrícula" value="${esc(b.reg)}" aria-label="Matrícula">
        <input type="text" data-k="type" class="${byAI(b, 'type')}" placeholder="Tipo (A320)" value="${esc(b.type)}" aria-label="Tipo">
        <input type="text" data-k="op" class="${byAI(b, 'op')}" placeholder="Operador" value="${esc(b.op)}" aria-label="Operador">
        <label class="field"><input type="checkbox" data-k="on" ${b.on ? 'checked' : ''}> Guardar</label>
      </div>
      ${aiLine(b)}
      <div class="strip">${b.frames.map(f => `<button class="th ${f.name === view ? 'v' : ''}" data-f="${esc(f.name)}" title="${esc(f.name)}">${f.thumb ? `<img src="${f.thumb}" alt="">` : ''}${f.name === b.n ? '<span class="tagn">★ N</span>' : f.name === b.x ? '<span class="tagx">X</span>' : ''}${f.err ? '<span class="bad">sin previa</span>' : DETECTAR_CORTES && f.cortadoIA ? '<span class="bad">cortado</span>' : DETECTAR_CORTES && f.obst ? '<span class="bad">algo delante</span>' : DETECTAR_CORTES && f.touches && !f.enteroIA ? '<span class="bad soft" title="Puede que el avión se salga del encuadre; la IA lo comprueba en la principal">¿cortado?</span>' : f.soft ? '<span class="bad soft">¿menos nítida?</span>' : ''}<span class="num">${esc(base(f.name).slice(-4))}</span></button>`).join('')}</div>
      <p class="hint">Haz clic en la foto grande para verla a pantalla completa, y en una miniatura para verla en grande y elige si es la <b>principal (★ N)</b> o la <b>segunda (X)</b>.</p>
    </div>`;
  el.querySelectorAll('input[data-k]').forEach(i => {
    i.oninput = () => {
      const kk = i.dataset.k; b[kk] = kk === 'on' ? i.checked : (kk === 'reg' ? i.value.toUpperCase().trim() : i.value.trim());
      b.touched[kk] = true; if (kk !== 'on') i.classList.remove('byai');
      if (kk === 'on') el.classList.toggle('off', !b.on); updateSave();
    };
    i.onchange = () => { i.oninput(); if (i.dataset.k === 'reg') { markSimilar(); markDups(); renderAll(); updateAIBar(); } };
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
  else if (a.dataset.act === 'mergedup') { const t = bursts.find(x => x.id === b.dupOf); if (t) mergeBursts(t.id, b.id); return; }
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
  const todo = (list || bursts.filter(b => b.on && !b.ai)).filter(b => b.n && !AI.busy.has(b));
  if (!todo.length) { updateAIBar(); return; }
  const apt = $('#apt').value.trim().toUpperCase();
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
        applyAI(b, await identificar(b, { token, aeropuerto: apt, fecha: ymd(b.frames[0].t), comparar: COMPARAR }));
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
}
function refresh(b) { if (bursts.includes(b)) renderBurst(b); }
function renderStat() {
  const sim = bursts.filter(b => b.similar).length;
  $('#addStat').textContent = `${bursts.reduce((a, b) => a + b.frames.length, 0)} archivos · ${bursts.length} ráfagas · ${folder}` + (sim ? ` · ${sim} ${sim === 1 ? 'parece' : 'parecen'} el mismo avión que la anterior (revisa «Unir con la anterior»)` : '');
}
function applyAI(b, r) {
  // Segunda pasada tras unir (con la mejor foto y la segunda): si lee peor que la primera, se queda la primera
  const repaso = b.enRepaso; delete b.enRepaso;
  if (repaso && b.ai?.hay_avion && valorIA(r) < valorIA(b.ai)) { aplicarEntero(b, r); return; }
  b.ai = r;
  if (!r.hay_avion) { if (!b.touched.on) b.on = false; return; }
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
  const raiz = new Map();   // matrícula → primera ráfaga con ella
  bursts.forEach(b => {
    const k = claveReg(b.reg); if (!k) return;
    if (raiz.has(k)) { b.dupOf = raiz.get(k).id; b.dupPor = 'reg'; } else raiz.set(k, b);
  });
  bursts.forEach(b => {
    if (claveReg(b.reg)) return;
    const re = patronParcial(b.ai?.matricula_parcial); if (!re) return;
    const regs = [...raiz.keys()].filter(k => re.test(k));
    if (regs.length === 1) { b.dupOf = raiz.get(regs[0]).id; b.dupPor = 'parcial'; }
  });
  // avión ya reconocido (por 1 o 2) de cada ráfaga
  const avion = new Map();
  bursts.forEach(b => { const k = claveReg(b.reg) || (b.dupPor === 'parcial' ? claveReg(bursts.find(x => x.id === b.dupOf)?.reg) : ''); if (k) avion.set(b, k); });
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
      const regs = new Set(bursts.filter(o => avion.has(o) && separacion(b, o) < CERCA && casa(b, o)).map(o => avion.get(o)));
      if (regs.size === 1) k = [...regs][0];
    } else {
      const p = bursts[i - 1], n = bursts[i + 1];
      if (p && n && avion.get(p) && avion.get(p) === avion.get(n) && separacion(b, p) < CERCA && separacion(b, n) < CERCA) k = avion.get(p);
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
  const missing = bursts.filter(b => b.on && b.n && !b.ai && !AI.busy.has(b)).length;
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
function notaDe(b) {
  const r = b.ai, rev = [];
  if (b.warn) rev.push(b.warn);
  if (r && r.hay_avion) {
    if (!r.matricula) rev.push(r.matricula_parcial ? 'matrícula parcial ' + r.matricula_parcial : r.codigo ? 'serial no legible (código ' + r.codigo + ')' : 'matrícula no legible');
    if (r.confianza === 'baja') rev.push('IA con confianza baja');
    if (r.matricula && r.verificado !== true) rev.push('tipo sin verificar con la ficha de la matrícula');
    if (r.otro_avion_en?.length) rev.push('puede haber otro avión en la ráfaga');
    if (r.para && r.para !== b.n) rev.push('la IA miró otra foto de la ráfaga');
    if (b.touched.reg && r.matricula && claveReg(r.matricula) !== claveReg(b.reg)) rev.push('la IA leyó ' + r.matricula);
  }
  return [rev.length ? '⚠ Revisar: ' + rev.join('; ') : '', r ? `IA (${r.confianza}): ${r.motivo}` : ''].filter(Boolean).join(' · ');
}

function updateSave() { const n = bursts.filter(b => b.on && b.n).length, off = bursts.filter(b => !b.on).length; $('#saveStat').textContent = `${n} ráfagas se guardarán como pendientes en «${folder}»` + (off ? ` · ${off} desmarcadas` : ''); $('#saveBtn').disabled = !n; }
$('#saveBtn').onclick = async () => {
  const todo = bursts.filter(b => b.on && b.n && !b.saved);
  const apt = $('#apt').value.trim().toUpperCase();
  $('#saveBtn').disabled = true; let ok = 0, fail = 0;
  for (const b of todo) {
    const nF = b.frames.find(f => f.name === b.n);
    let thumb_path = null;
    if (nF?.keepBlob) {
      thumb_path = `${user.id}/${uid()}.jpg`;
      const up = await sb.storage.from('thumbs').upload(thumb_path, nF.keepBlob, { contentType: 'image/jpeg' });
      if (up.error) thumb_path = null;
    }
    const row = { fecha: ymd(b.frames[0].t), matricula: b.reg, tipo: b.type, operador: b.op, aeropuerto: apt, carpeta: folder, archivo: base(b.n), archivo2: b.x ? base(b.x) : '', nota: notaDe(b), pendiente: true, thumb_path };
    if (b.ai) row.ia = { ...b.ai, otras_tomas: undefined, otro_avion_en: undefined };
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
