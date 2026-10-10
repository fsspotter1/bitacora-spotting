import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { RAW_RE, readFrame, captureTime, analyse, pickBest } from './raw.js';

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
  S.entries = all; renderLog(); loadThumbs();
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

/* ---------------- registrar carpeta ---------------- */
let bursts = [], folder = '';
$('#pickBtn').onclick = () => $('#pick').click();
$('#pick').onchange = async ev => {
  const files = [...ev.target.files].filter(f => RAW_RE.test(f.name) && !f.name.startsWith('.'));
  ev.target.value = '';
  if (!files.length) { $('#addStat').textContent = 'No hay RAW en esa carpeta.'; return; }
  folder = (files[0].webkitRelativePath || '').split('/')[0] || '';
  bursts = []; $('#bursts').innerHTML = ''; $('#saveBar').hidden = true; $('#pickBtn').disabled = true;
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
  bursts.forEach((b, i) => Object.assign(b, { id: i, reg: '', type: '', op: '', on: true }));
  done = 0;
  for (const b of bursts) {
    const queue = [...b.frames];
    await Promise.all([0, 1, 2].map(async () => { while (queue.length) { const f = queue.shift(); if (!f.err) { try { Object.assign(f, await analyse(f.blob)); } catch { f.err = true; } } done++; } }));
    pickBest(b); renderBurst(b); prog(`Analizando ${done}/${total} · ráfaga ${b.id + 1}/${bursts.length}`);
  }
  $('#bar').style.width = '100%';
  $('#addStat').textContent = `${total} archivos · ${bursts.length} ráfagas · ${folder}`;
  $('#pickBtn').disabled = false; $('#saveBar').hidden = false; updateSave();
};
const hm = t => new Date(t).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function renderBurst(b) {
  let el = document.getElementById('b' + b.id);
  if (!el) { el = document.createElement('article'); el.id = 'b' + b.id; $('#bursts').appendChild(el); }
  el.className = 'burst' + (b.on ? '' : ' off');
  const nF = b.frames.find(f => f.name === b.n); const k = b.frames.length;
  el.innerHTML = `
    <div class="hero">${nF?.large ? `<img src="${nF.large}" alt="Toma elegida ${esc(base(b.n))}">` : ''}<span class="badge">N · ${esc(b.n ? base(b.n) : '—')}</span></div>
    <div class="meta">
      <div class="row"><span class="time">${hm(b.frames[0].t)}</span><span class="files">${esc(base(b.frames[0].name))} – ${esc(base(b.frames[k - 1].name))} · ${k} ${k === 1 ? 'foto' : 'fotos'}${b.x ? ` · X ${esc(base(b.x))}` : ''}</span></div>
      <div class="inputs">
        <input type="text" class="reg" data-k="reg" placeholder="Matrícula" value="${esc(b.reg)}" aria-label="Matrícula">
        <input type="text" data-k="type" placeholder="Tipo (A320)" value="${esc(b.type)}" aria-label="Tipo">
        <input type="text" data-k="op" placeholder="Operador" value="${esc(b.op)}" aria-label="Operador">
        <label class="field"><input type="checkbox" data-k="on" ${b.on ? 'checked' : ''}> Guardar</label>
      </div>
      <div class="strip">${b.frames.map(f => `<button class="th ${f.name === b.n ? 'n' : ''} ${f.name === b.x ? 'x' : ''}" data-b="${b.id}" data-f="${esc(f.name)}" title="${esc(f.name)}">${f.thumb ? `<img src="${f.thumb}" alt="">` : ''}${f.err ? '<span class="bad">sin previa</span>' : (f.touches ? '<span class="bad">cortado</span>' : '')}<span>${esc(base(f.name).slice(-4))}</span></button>`).join('')}</div>
      <p class="hint">Clic: foto principal (N) · Mayús+clic: segunda foto (X)</p>
    </div>`;
  el.querySelectorAll('input[data-k]').forEach(i => i.oninput = i.onchange = () => {
    const kk = i.dataset.k; b[kk] = kk === 'on' ? i.checked : (kk === 'reg' ? i.value.toUpperCase().trim() : i.value.trim());
    if (kk === 'on') el.classList.toggle('off', !b.on); updateSave();
  });
}
$('#bursts').addEventListener('click', e => {
  const t = e.target.closest('.th'); if (!t) return;
  const b = bursts[+t.dataset.b], f = t.dataset.f;
  if (e.shiftKey) { b.x = b.x === f ? '' : f; if (b.x === b.n) b.x = ''; } else { if (b.x === f) b.x = b.n; b.n = f; }
  renderBurst(b);
});
function updateSave() { const n = bursts.filter(b => b.on && b.n).length; $('#saveStat').textContent = `${n} ráfagas se guardarán como pendientes en «${folder}»`; $('#saveBtn').disabled = !n; }
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
    const row = { fecha: ymd(b.frames[0].t), matricula: b.reg, tipo: b.type, operador: b.op, aeropuerto: apt, carpeta: folder, archivo: base(b.n), archivo2: b.x ? base(b.x) : '', pendiente: true, thumb_path };
    const { data, error } = await sb.from('entries').insert(row).select().single();
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
