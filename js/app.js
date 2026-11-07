// Folio on the phone: the screens, and the reading queue that drives them.
import { Store, Prefs, makeBackup, restoreBackup } from './store.js';
import { LANGUAGES, QUALITIES, defaultOCR, readKey, ocrSummary, pace, Source, isRTL, columnCount, readPage, stopOCR } from './reader.js';
import { defaultExport, PRESETS, MARKERS, HEADINGS, render as renderText, ruleRegex, stats } from './export.js';
import { defaultWordOptions, frequencies, phrases, contexts, docStats, csv } from './words.js';
import { defaultEdition, editionCSS, editionBody, editionDocument } from './edition.js';
import { defaultEpub, makeEPUB } from './epub.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const body = document.body;
const phone = () => matchMedia('(max-width: 820px)').matches;
const touch = matchMedia('(pointer: coarse)').matches;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const ICON = {
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  forget: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
};

// ---------- state ----------

const S = {
  doc: null, source: null, files: null,
  page: 1, sel: null, overlay: 'boxes', zoom: 1, itab: 'blocks', outWhole: true, hideRemoved: false,
  search: '', hits: [], hitSet: new Set(), hitIdx: -1,
  queue: [], reading: null, done: 0, gen: 0, guess: {},
  undo: [], redo: [],
  img: null, scanTok: 0, inspPage: null,
};
const thumbs = new Map();
const page = (n = S.page) => S.doc.pages[n - 1];
const title = () => (S.doc.edition?.title || S.doc.name).replace(/\.(pdf|jpe?g|png|heic|webp|tiff?)$/i, '');

// ---------- small helpers ----------

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function fmtTime(sec) {
  if (sec < 45) return 'under a minute';
  if (sec < 90) return 'about a minute';
  if (sec < 3600) return `about ${Math.round(sec / 60)} minutes`;
  return `about ${(sec / 3600).toFixed(1)} hours`;
}
const fmtSize = b => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
function ago(t) {
  if (!t) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 2) return 'yesterday';
  if (d < 86400 * 30) return `${Math.round(d / 86400)} days ago`;
  return new Date(t).toLocaleDateString();
}
const LANG_NAMES = { deu: 'German', 'ara+eng': 'Arabic', 'ara+deu': 'Arabic & German', ara: 'Arabic', eng: 'English' };
const norm = s => s.toLocaleLowerCase().replace(/[ً-ْـ]/g, '');

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch { toast('Couldn’t copy'); }
    ta.remove();
  }
}

/** iPhone: the share sheet (Save to Files, AirDrop, Mail…). Elsewhere: a download. */
async function saveBlob(name, blob) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (touch && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

/** For files made after a wait: iOS only shares from a fresh tap, so ask for one. */
function offerFile(name, blob, note = '') {
  const el = openSheet(`${sheetHead('Ready')}
    <div class="sheet-body"><p style="font-size:19px;margin:0 0 4px;word-break:break-word">${esc(name)}</p>
    <p class="note">${fmtSize(blob.size)}${note ? ' · ' + esc(note) : ''}</p></div>
    <div class="sheet-foot"><button class="btn" data-close>Close</button><span class="spacer"></span>
    <button class="btn btn-ink" data-save>Save…</button></div>`, { cls: 'narrow' });
  el.querySelector('[data-save]').onclick = () => saveBlob(name, blob);
}

// ---------- sheets ----------

let sheetOnClose = null;
function openSheet(html, { cls = '', onClose } = {}) {
  const prev = sheetOnClose;
  sheetOnClose = null;
  prev?.();
  const el = $('#sheet');
  el.className = 'sheet ' + cls;
  el.innerHTML = html;
  el.hidden = false;
  $('#sheet-backdrop').hidden = false;
  sheetOnClose = onClose || null;
  return el;
}
function closeSheet() {
  const f = sheetOnClose;
  sheetOnClose = null;
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  $('#sheet').innerHTML = '';
  f?.();
}
const sheetHead = (t, sub = '') => `<div class="sheet-head"><div class="titles">${sub ? `<p class="eyebrow" style="margin:0 0 2px">${esc(sub)}</p>` : ''}<h2>${esc(t)}</h2></div><button class="icon-btn" data-close aria-label="Close">${ICON.x}</button></div>`;
$('#sheet-backdrop').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });

function confirmSheet(heading, text, ok, danger = false) {
  return new Promise(resolve => {
    let answered = false;
    const el = openSheet(`${sheetHead(heading)}<div class="sheet-body"><p style="margin:0">${esc(text)}</p></div>
      <div class="sheet-foot"><button class="btn" data-close>Cancel</button><span class="spacer"></span>
      <button class="btn ${danger ? 'btn-accent' : 'btn-ink'}" data-yes>${esc(ok)}</button></div>`,
    { cls: 'narrow', onClose: () => { if (!answered) resolve(false); } });
    el.querySelector('[data-yes]').onclick = () => { answered = true; closeSheet(); resolve(true); };
  });
}

const radios = (name, items, value) => items.map(i => `<button type="button" class="radio${i.id === value ? ' on' : ''}" data-radio="${name}" data-val="${i.id}"><span class="dot"></span><span><b>${esc(i.label)}</b>${i.detail ? `<small>${esc(i.detail)}</small>` : ''}</span></button>`).join('');
const check = (key, label, on, attr = 'data-k') => `<label class="check"><input type="checkbox" ${attr}="${key}" ${on ? 'checked' : ''}> ${esc(label)}</label>`;

// ---------- appearance ----------

function applyAppearance() {
  const a = Prefs.get('appearance');
  const root = document.documentElement;
  if (a === 'paper') root.dataset.theme = 'light';
  else if (a === 'ink') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  const metas = $$('meta[name="theme-color"]');
  if (a === 'system') {
    metas[0].content = '#F6F2EA'; metas[1].content = '#1E1A15';
  } else {
    const c = a === 'ink' ? '#1E1A15' : '#F6F2EA';
    metas.forEach(m => { m.content = c; });
  }
}

function appearanceSheet() {
  const items = [
    { id: 'system', label: 'Like the phone', detail: 'Paper by day, ink at night' },
    { id: 'paper', label: 'Paper', detail: 'Warm light pages' },
    { id: 'ink', label: 'Ink', detail: 'Dark, for reading at night' },
  ];
  const el = openSheet(`${sheetHead('Appearance')}<div class="sheet-body">${radios('ap', items, Prefs.get('appearance'))}</div>`, { cls: 'narrow' });
  el.addEventListener('click', e => {
    const r = e.target.closest('[data-radio]');
    if (!r) return;
    Prefs.set('appearance', r.dataset.val);
    applyAppearance();
    $$('[data-radio]', el).forEach(x => x.classList.toggle('on', x === r));
  });
}

// ---------- welcome: recents and backups ----------

function summaryOf(s) {
  const pages = s.pages || [];
  const read = pages.filter(p => p.source !== 'pending').length;
  const corr = pages.reduce((a, p) => a + (p.blocks || []).filter(b => b.text !== b.original).length, 0);
  const parts = [`${pages.length} page${pages.length === 1 ? '' : 's'}`];
  parts.push(read === pages.length ? 'all read' : `${read} read`);
  if (corr) parts.push(`${corr} corrected`);
  if (s.filesStored === false) parts.push('text only');
  parts.push(ago(s.opened));
  return parts.join(' · ');
}

async function renderRecents() {
  let all = [];
  try { all = await Store.allSessions(); } catch (e) { toast('Storage isn’t available: ' + e.message); }
  all.sort((a, b) => (b.opened || 0) - (a.opened || 0));
  const q = norm($('#recent-filter').value.trim());
  const shown = q ? all.filter(s => norm(s.name).includes(q)) : all;
  $('#recent-list').innerHTML = shown.map((s, i) => `<li>
    <span class="num">${i + 1}</span>
    <button class="open" data-open="${esc(s.id)}"><span class="name">${esc(s.name)}</span><span class="sum">${esc(summaryOf(s))}</span></button>
    <button class="icon-btn" data-forget="${esc(s.id)}" aria-label="Forget ${esc(s.name)}">${ICON.forget}</button></li>`).join('');
  $('#recent-empty').hidden = all.length > 0;
  $('.recents-head input').hidden = all.length < 6;
}

$('#recent-filter').addEventListener('input', renderRecents);
$('#recent-list').addEventListener('click', async e => {
  const o = e.target.closest('[data-open]');
  if (o) return openSession(o.dataset.open);
  const f = e.target.closest('[data-forget]');
  if (f) {
    const s = await Store.session(f.dataset.forget);
    if (!s) return;
    if (await confirmSheet('Forget this file?', `“${s.name}”, its text and your corrections are removed from this phone. This can’t be undone.`, 'Forget', true)) {
      await Store.forget(s.id);
      renderRecents();
      toast('Forgotten');
    }
  }
});

async function exportBackup() {
  const withFiles = $('#backup-files').checked;
  toast('Making the backup…', 20000);
  try {
    const b = await makeBackup(withFiles);
    const blob = new Blob([JSON.stringify(b)], { type: 'application/json' });
    const d = new Date().toISOString().slice(0, 10);
    $('#toast').hidden = true;
    offerFile(`Folio backup ${d}.json`, blob, `${b.sessions.length} file${b.sessions.length === 1 ? '' : 's'}${withFiles ? ', with originals' : ''}`);
  } catch (e) { toast('Couldn’t make the backup: ' + e.message); }
}

$('#backup-input').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    if (!await confirmSheet('Import this backup?', `${json.sessions?.length ?? 0} files from ${json.exported ? new Date(json.exported).toLocaleDateString() : 'a backup'}. Files already here are kept; the same file in the backup replaces its copy here.`, 'Import')) return;
    const r = await restoreBackup(json);
    applyAppearance();
    renderRecents();
    toast(`Imported ${r.sessions} file${r.sessions === 1 ? '' : 's'}${r.sessions && r.withFiles < r.sessions ? ' (some as text only)' : ''}`);
  } catch (err) { toast(err.message || 'That file couldn’t be read.'); }
});

$('#file-input').addEventListener('change', e => {
  const list = [...e.target.files];
  e.target.value = '';
  openFiles(list);
});

async function engineNote() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage) $('#engine-note').textContent = `Everything happens on this phone. Nothing is uploaded. · ${fmtSize(est.usage)} kept here`;
  } catch {}
}

// ---------- opening ----------

const isPDF = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
async function readFiles(list) {
  return Promise.all(list.map(async f => ({ name: f.name, type: f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : 'image/jpeg'), data: await f.arrayBuffer() })));
}

async function hashFiles(files) {
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  try {
    const parts = [];
    for (const f of files) parts.push(hex(await crypto.subtle.digest('SHA-256', f.data)));
    return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('')))).slice(0, 24);
  } catch {
    // No crypto.subtle (plain http): a quick FNV over sizes and a sample of bytes.
    let h = 0x811c9dc5;
    for (const f of files) {
      const b = new Uint8Array(f.data);
      const step = Math.max(1, Math.floor(b.length / 65536));
      for (let i = 0; i < b.length; i += step) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
      h ^= b.length; h = Math.imul(h, 0x01000193) >>> 0;
    }
    return 'f' + h.toString(16);
  }
}

function fillDefaults(doc) {
  doc.ocr = { ...defaultOCR(), ...(doc.ocr || {}) };
  doc.export = { ...defaultExport(), ...(doc.export || {}) };
  doc.edition = { ...defaultEdition(), ...(doc.edition || {}) };
  doc.epub = { ...defaultEpub(), ...(doc.epub || {}) };
  doc.words = { ...defaultWordOptions(), ...(doc.words || {}) };
  return doc;
}

async function newSession(id, files, source) {
  const pages = [];
  for (let n = 1; n <= source.pageCount; n++) {
    const { w, h } = await source.size(n);
    pages.push({ n, w, h, source: 'pending', blocks: [], excluded: false, readWith: null, pinned: null, cols: 1 });
  }
  return fillDefaults({
    id, name: files.length === 1 ? files[0].name : `${files.length} photos`, kind: source.kind,
    created: Date.now(), opened: Date.now(), pages,
    ocr: { ...defaultOCR(), ...(Prefs.get('lastOCR') || {}) },
    filesStored: true, lastPage: 1,
  });
}

async function openFiles(list) {
  if (!list.length) return;
  toast('Opening…', 30000);
  try {
    let files = await readFiles(list);
    const pdf = files.find(isPDF);
    if (pdf) {
      if (files.length > 1) toast('Opening the PDF; photos picked with it are left aside.');
      files = [pdf];
    }
    const id = await hashFiles(files);
    const source = await Source.open(files);
    let doc = await Store.session(id);
    const fresh = !doc;
    if (fresh) doc = await newSession(id, files, source);
    else fillDefaults(doc);
    try { await Store.saveFiles(id, files); doc.filesStored = true; }
    catch { doc.filesStored = false; toast('This phone is short of space: the text is kept, the original isn’t.', 4000); }
    doc.opened = Date.now();
    await Store.saveSession(doc);
    Store.persist();
    if ($('#toast').textContent === 'Opening…') $('#toast').hidden = true;
    enterWorkspace(doc, source, files);
    if (fresh) {
      if (Prefs.get('askBeforeReading')) settingsSheet('setup');
      else enqueue(unread());
    }
  } catch (e) {
    console.error(e);
    toast(/password/i.test(e.message) ? 'This PDF is locked with a password.' : `Couldn’t open that: ${e.message}`, 4000);
  }
}

async function openSession(id) {
  const doc = await Store.session(id);
  if (!doc) return;
  fillDefaults(doc);
  let files = null, source = null;
  try {
    files = await Store.files(id);
    if (files?.length) source = await Source.open(files);
  } catch (e) { console.error(e); }
  doc.opened = Date.now();
  Store.saveSession(doc);
  enterWorkspace(doc, source, files);
}

async function reattach(list) {
  try {
    let files = await readFiles(list);
    const pdf = files.find(isPDF);
    if (pdf) files = [pdf];
    if (await hashFiles(files) !== S.doc.id) return toast('That’s a different file from the one read here.', 3500);
    S.source = await Source.open(files);
    S.files = files;
    try { await Store.saveFiles(S.doc.id, files); S.doc.filesStored = true; save(); } catch {}
    observeThumbs();
    renderAll();
    toast('The scan is back.');
  } catch (e) { toast('Couldn’t open that: ' + e.message); }
}

function enterWorkspace(doc, source, files) {
  Object.assign(S, {
    doc, source, files, page: Math.min(doc.lastPage || 1, doc.pages.length), sel: null, zoom: 1, itab: 'blocks',
    search: '', hits: [], hitSet: new Set(), hitIdx: -1, queue: [], reading: null, done: 0, guess: {},
    undo: [], redo: [], inspPage: null,
  });
  S.gen++;
  if (S.img) { URL.revokeObjectURL(S.img.url); S.img = null; }
  thumbs.clear();
  $('#search-input').value = '';
  $('#search-row').hidden = true;
  body.dataset.view = 'workspace';
  setTab(body.dataset.tab || 'text', false);
  $$('#text-panel [data-itab]').forEach(b => b.classList.toggle('on', b.dataset.itab === 'blocks'));
  renderAll();
  observeThumbs();
}

async function closeDoc() {
  if (S.reading || S.queue.length) { S.gen++; S.queue = []; S.reading = null; stopOCR(); }
  await save(true);
  closeSheet();
  if (S.img) { URL.revokeObjectURL(S.img.url); S.img = null; }
  $('#print-root').innerHTML = '';
  S.doc = null; S.source = null; S.files = null;
  thumbs.clear();
  body.dataset.view = 'welcome';
  renderRecents();
  engineNote();
}

// ---------- saving and undo ----------

let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  const doc = S.doc;
  if (!doc) return Promise.resolve();
  const write = () => Store.saveSession(doc).catch(e => toast('Couldn’t save: ' + e.message, 4000));
  if (now) return write();
  saveTimer = setTimeout(write, 400);
  return Promise.resolve();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(true); });

function snapshot(label) {
  S.undo.push({ label, pages: structuredClone(S.doc.pages) });
  if (S.undo.length > 50) S.undo.shift();
  S.redo = [];
}
function undo() {
  const s = S.undo.pop();
  if (!s) return toast('Nothing to undo');
  S.redo.push({ label: s.label, pages: structuredClone(S.doc.pages) });
  S.doc.pages = s.pages;
  save(); renderAll();
  toast('Undone: ' + s.label);
}
function redo() {
  const s = S.redo.pop();
  if (!s) return toast('Nothing to redo');
  S.undo.push({ label: s.label, pages: structuredClone(S.doc.pages) });
  S.doc.pages = s.pages;
  save(); renderAll();
  toast('Redone: ' + s.label);
}

// ---------- reading ----------

const settingsFor = p => (p.pinned ? { ...S.doc.ocr, language: p.pinned } : S.doc.ocr);
function isStale(p) {
  if (p.source === 'pending' || p.error) return false;
  const s = settingsFor(p);
  if (p.source === 'text') return !!s.forceOCR;
  return !!p.readWith && p.readWith !== readKey(s);
}
const unread = () => S.doc.pages.filter(p => !p.excluded && p.source === 'pending').map(p => p.n);
const staleOnes = () => S.doc.pages.filter(p => !p.excluded && isStale(p)).map(p => p.n);

function enqueue(ns, { front = false } = {}) {
  if (!S.source) return toast('Open the original file again to read it.', 3000);
  const cur = S.reading?.n;
  const add = ns.filter(n => n !== cur);
  S.queue = front ? [...add, ...S.queue.filter(n => !add.includes(n))] : [...S.queue, ...add.filter(n => !S.queue.includes(n))];
  renderBar();
  add.forEach(updatePageItem);
  pump();
}

async function pump() {
  if (S.reading || !S.queue.length) return;
  const gen = S.gen, doc = S.doc, source = S.source;
  while (S.queue.length && gen === S.gen) {
    const n = S.queue.shift();
    const settings = { ...settingsFor(doc.pages[n - 1]) };
    S.reading = { n, settings, status: '', progress: 0, started: performance.now() };
    renderBar(); updatePageItem(n);
    if (n === S.page) renderInspector();
    try {
      const r = await readPage(source, n, settings, S.guess, m => onReadProgress(m, gen));
      if (gen !== S.gen) return;
      const p = doc.pages[n - 1]; // fetched again: undo may have swapped the pages meanwhile
      Object.assign(p, { blocks: r.blocks, source: r.source, readWith: readKey(settings), langs: r.langs || null, cols: columnCount(r.blocks), error: null });
      if (r.source === 'text') p.hasText = true;
      S.done++;
      save();
    } catch (e) {
      if (gen !== S.gen) return;
      console.error(e);
      doc.pages[n - 1].error = String(e.message || e);
      toast(`Page ${n} couldn’t be read: ${doc.pages[n - 1].error}`, 4000);
    }
    S.reading = null;
    pageChanged(n);
  }
  if (gen !== S.gen) return;
  S.reading = null;
  if (!S.queue.length && S.done) toast(S.done === 1 ? 'Read.' : `${S.done} pages read.`);
  S.done = 0;
  renderBar();
}

async function stopReading() {
  S.gen++;
  const was = [S.reading?.n, ...S.queue].filter(Boolean);
  S.queue = []; S.reading = null; S.done = 0;
  await stopOCR();
  renderBar();
  was.forEach(updatePageItem);
  if (was.includes(S.page)) renderInspector();
  toast('Stopped. The pages read so far are kept.');
}

const STATUS = {
  'loading tesseract core': 'Starting the reader',
  'initializing tesseract': 'Starting the reader',
  'initialized tesseract': 'Starting the reader',
  'loading language traineddata': 'Loading the language',
  'loaded language traineddata': 'Loading the language',
  'initializing api': 'Getting ready',
  'initialized api': 'Getting ready',
  'recognizing text': 'Reading',
};
let progressFrame = 0;
function onReadProgress(m, gen) {
  if (gen !== S.gen || !S.reading) return;
  S.reading.status = STATUS[m.status] || '';
  if (m.status === 'recognizing text') S.reading.progress = m.progress || 0;
  if (!progressFrame) progressFrame = requestAnimationFrame(() => { progressFrame = 0; renderBar(); });
}

function queueSeconds() {
  let t = 0;
  for (const n of S.queue) {
    const p = page(n), s = settingsFor(p);
    t += p.hasText && !s.forceOCR ? pace.text : pace.ocr[s.quality];
  }
  if (S.reading) {
    const s = S.reading.settings;
    const per = pace.ocr[s.quality];
    t += Math.max(0, per - (performance.now() - S.reading.started) / 1000);
  }
  return t;
}

function renderBar() {
  const bar = $('#reading-bar');
  if (!S.doc) return;
  let key, html;
  if (S.reading) {
    const r = S.reading;
    key = 'reading';
    const total = S.done + S.queue.length + 1;
    const pct = Math.min(100, ((S.done + r.progress) / total) * 100);
    const label = `Reading page ${r.n}${S.queue.length ? ` · ${S.queue.length} more` : ''}`;
    const em = `${r.status ? r.status + (r.status === 'Reading' ? ` ${Math.round(r.progress * 100)}%` : '…') + ' · ' : ''}${fmtTime(queueSeconds())} left · ${ocrSummary(r.settings)}`;
    if (bar.dataset.key === key) {
      bar.querySelector('[data-l]').textContent = label;
      bar.querySelector('[data-e]').textContent = em;
      bar.querySelector('.progress i').style.width = pct + '%';
      return;
    }
    html = `<span class="spin"></span><div class="label"><span data-l>${esc(label)}</span><em data-e>${esc(em)}</em></div>
      <button class="btn btn-small" data-action="settings">Settings</button>
      <button class="btn btn-small btn-accent" data-action="stop">Stop</button>
      <div class="progress"><i style="width:${pct}%"></i></div>`;
  } else if (S.source && unread().length) {
    const k = unread().length;
    key = 'unread' + k;
    html = `<div class="label">${k} page${k === 1 ? '' : 's'} not read yet<em>${esc(ocrSummary(S.doc.ocr))}</em></div>
      <button class="btn btn-small" data-action="settings">Settings</button>
      <button class="btn btn-small btn-ink" data-action="read-unread">Read ${k === 1 ? 'it' : 'them'}</button>`;
  } else if (S.source && staleOnes().length) {
    const k = staleOnes().length;
    key = 'stale' + k;
    html = `<div class="label">${k} page${k === 1 ? ' was' : 's were'} read with other settings<em>Now: ${esc(ocrSummary(S.doc.ocr))}</em></div>
      <button class="btn btn-small" data-action="read-stale">Read again</button>`;
  } else {
    bar.hidden = true;
    bar.dataset.key = '';
    return;
  }
  bar.hidden = false;
  bar.dataset.key = key;
  bar.innerHTML = html;
}

async function readAgain(ns, label) {
  const corrected = ns.some(n => page(n).blocks.some(b => b.text !== b.original));
  if (corrected && !await confirmSheet('Read again?', `Your corrections on ${ns.length === 1 ? 'this page' : 'these pages'} will be replaced by a fresh reading. Undo brings them back.`, 'Read again')) return;
  snapshot(label);
  ns.forEach(n => { page(n).error = null; });
  enqueue(ns, { front: ns.length === 1 });
}

// ---------- settings: before and while reading ----------

function parseRange(s, N) {
  s = s.trim();
  if (!s || /^(all|alle|كل)$/i.test(s)) return Array.from({ length: N }, (_, i) => i + 1);
  const out = new Set();
  for (const raw of s.split(/[,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)?\s*[-–]\s*(\d+)?$/);
    if (m && (m[1] || m[2])) {
      const a = +(m[1] || 1), b = +(m[2] || N);
      for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(N, Math.max(a, b)); i++) out.add(i);
    } else if (/^\d+$/.test(part)) {
      const v = +part;
      if (v >= 1 && v <= N) out.add(v);
    } else return null;
  }
  return [...out].sort((a, b) => a - b);
}

async function estimate(ns, o) {
  let t = 0, checked = 0;
  for (const n of ns) {
    const p = page(n);
    if (p.hasText === undefined && S.source?.kind === 'pdf' && checked++ < 300) p.hasText = await S.source.hasText(n);
    t += p.hasText && !o.forceOCR ? pace.text : pace.ocr[o.quality];
  }
  return t;
}

function settingsSheet(mode = 'live') {
  const setup = mode === 'setup';
  const o = { ...S.doc.ocr };
  const N = S.doc.pages.length;
  let range = '';
  const el = openSheet(`${sheetHead(setup ? 'Before reading' : 'Reading settings', S.doc.name)}
    <div class="sheet-body">
      ${setup ? `<div class="thumbs" id="st-thumbs"></div>` : ''}
      ${!setup && S.reading ? `<p class="note">Changes apply from the next page. The page being read now finishes as it started.</p>` : ''}
      <div class="cols2">
        <div class="group"><h3>Language</h3>${radios('language', LANGUAGES, o.language)}</div>
        <div>
          <div class="group"><h3>Quality</h3>${radios('quality', QUALITIES, o.quality)}</div>
          <div class="group"><h3>Choices</h3>
            ${check('forceOCR', 'Read every page from the scan, even pages with their own text', o.forceOCR)}
            ${check('keepPageNumbers', 'Keep page numbers in the text', o.keepPageNumbers)}
          </div>
          ${setup && N > 1 ? `<div class="group"><h3>Pages</h3><label class="field">Which pages <input class="text" id="st-range" inputmode="numeric" placeholder="All ${N}, or e.g. 1-5, 9" autocomplete="off"></label><p class="error" id="st-range-err" hidden>Write pages like 1-5, 9, 12-</p></div>` : ''}
        </div>
      </div>
      <p class="note" id="st-est"></p>
      ${!setup ? `<div class="row wrap" id="st-live"></div>` : ''}
    </div>
    <div class="sheet-foot">
      ${setup ? `${check('ask', 'Ask like this before reading a new file', Prefs.get('askBeforeReading'), 'data-pref')}
        <button class="btn" data-later>Not now</button><span class="spacer"></span><button class="btn btn-ink" data-go>Read</button>`
      : `<span class="spacer"></span><button class="btn btn-ink" data-close>Done</button>`}
    </div>`, { cls: 'tall' });

  if (setup) {
    const box = el.querySelector('#st-thumbs');
    const show = Math.min(N, 6);
    box.innerHTML = Array.from({ length: show }, (_, i) => `<figure><img data-st="${i + 1}" alt=""><figcaption>${i + 1}</figcaption></figure>`).join('') + (N > show ? `<figure><figcaption>and ${N - show} more</figcaption></figure>` : '');
    $$('img[data-st]', box).forEach(img => getThumb(+img.dataset.st).then(u => { if (u) img.src = u; }));
  }

  let estTok = 0;
  const refresh = async () => {
    const tok = ++estTok;
    if (setup) {
      const ns = parseRange(range, N);
      el.querySelector('#st-range-err')?.toggleAttribute('hidden', !!ns);
      const go = el.querySelector('[data-go]');
      if (!ns || !ns.length) { go.disabled = true; return; }
      go.disabled = false;
      go.textContent = ns.length === N ? (N === 1 ? 'Read the page' : `Read all ${N} pages`) : `Read ${ns.length} page${ns.length === 1 ? '' : 's'}`;
      el.querySelector('#st-est').textContent = 'Working out the time…';
      const t = S.source ? await estimate(ns, o) : 0;
      if (tok !== estTok) return;
      const own = ns.filter(n => page(n).hasText).length;
      el.querySelector('#st-est').textContent = `Takes ${fmtTime(t)} on this phone${own && !o.forceOCR ? `; ${own} page${own === 1 ? ' has' : 's have'} their own text and need no reading` : ''}. You can stop, or change these settings, while it reads.`;
    } else {
      S.doc.ocr = { ...o };
      Prefs.set('lastOCR', { ...o });
      save(); renderBar(); renderHeader();
      const un = unread().length, st = staleOnes().length;
      el.querySelector('#st-live').innerHTML = `
        ${un && !S.reading ? `<button class="btn" data-live="unread">Read the ${un} unread page${un === 1 ? '' : 's'}</button>` : ''}
        ${st ? `<button class="btn" data-live="stale">Read ${st} page${st === 1 ? '' : 's'} again with these settings</button>` : ''}`;
      el.querySelector('#st-est').textContent = st ? `${st} page${st === 1 ? ' was' : 's were'} read with other settings. Their text stays until you read them again.` : '';
    }
  };

  el.addEventListener('click', e => {
    const r = e.target.closest('[data-radio]');
    if (r) {
      o[r.dataset.radio] = r.dataset.val;
      $$(`[data-radio="${r.dataset.radio}"]`, el).forEach(x => x.classList.toggle('on', x === r));
      refresh();
      return;
    }
    const l = e.target.closest('[data-live]');
    if (l) {
      closeSheet();
      if (l.dataset.live === 'unread') enqueue(unread());
      else readAgain(staleOnes(), 'reading again');
      return;
    }
    if (e.target.closest('[data-later]')) {
      S.doc.ocr = { ...o }; Prefs.set('lastOCR', { ...o }); save();
      closeSheet(); renderBar();
      return;
    }
    if (e.target.closest('[data-go]')) {
      const ns = parseRange(range, N);
      if (!ns?.length) return;
      S.doc.ocr = { ...o }; Prefs.set('lastOCR', { ...o }); save();
      closeSheet();
      renderHeader();
      enqueue(ns.filter(n => !page(n).excluded && page(n).source === 'pending'));
    }
  });
  el.addEventListener('change', e => {
    const k = e.target.dataset.k;
    if (k) { o[k] = e.target.checked; refresh(); }
    if (e.target.dataset.pref === 'ask') Prefs.set('askBeforeReading', e.target.checked);
  });
  el.querySelector('#st-range')?.addEventListener('input', e => { range = e.target.value; refresh(); });
  refresh();
}

// ---------- rendering the desk ----------

function renderAll() {
  if (!S.doc) return;
  renderHeader();
  renderPageList();
  renderScan();
  renderInspector();
  renderBar();
}

function renderHeader() {
  const d = S.doc;
  $('#doc-title').textContent = d.name;
  const read = d.pages.filter(p => p.source !== 'pending').length;
  const corr = d.pages.reduce((a, p) => a + p.blocks.filter(b => b.text !== b.original).length, 0);
  const out = d.pages.filter(p => p.excluded).length;
  $('#doc-summary').textContent = [
    `${d.pages.length} page${d.pages.length === 1 ? '' : 's'}`,
    read === d.pages.length ? 'all read' : `${read} read`,
    corr ? `${corr} corrected` : '',
    out ? `${out} left out` : '',
    !S.source ? 'scan not on this phone' : '',
  ].filter(Boolean).join(' · ');
}

function pageStatus(p) {
  if (S.reading?.n === p.n) return 'reading…';
  if (p.excluded) return 'left out';
  if (S.queue.includes(p.n)) return 'waiting';
  if (p.error) return 'couldn’t be read';
  const base = { pending: 'not read', text: 'its own text', ocr: 'read from the scan', empty: 'nothing found' }[p.source] || '';
  const corr = p.blocks.filter(b => b.text !== b.original).length;
  return base + (corr ? ` · ${corr} corrected` : '') + (isStale(p) ? ' · older settings' : '');
}

function pageItemHTML(p) {
  const hits = S.hits.filter(h => h.page === p.n).length;
  const t = thumbs.get(p.n);
  return `<button class="page-item${p.n === S.page ? ' on' : ''}${p.excluded ? ' excluded' : ''}" data-page="${p.n}">
    <img class="thumb" data-thumb="${p.n}" alt="" ${t ? `src="${t}"` : ''}>
    <span class="meta"><span class="n">${p.n}</span><span class="st">${esc(pageStatus(p))}</span>${hits ? `<span class="hits">${hits} found</span>` : ''}</span></button>`;
}

function renderPageList() {
  const ol = $('#page-list');
  ol.innerHTML = S.doc.pages.map(p => `<li>${pageItemHTML(p)}</li>`).join('');
  const out = S.doc.pages.filter(p => p.excluded).length;
  $('#pages-count').textContent = `${S.doc.pages.length}${out ? ` · ${out} out` : ''}`;
  observeThumbs();
}

function updatePageItem(n) {
  const btn = $(`#page-list [data-page="${n}"]`);
  if (!btn || !S.doc) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = pageItemHTML(page(n));
  const fresh = tmp.firstElementChild;
  const img = btn.querySelector('img');
  if (img?.src && !fresh.querySelector('img').src) fresh.querySelector('img').src = img.src;
  btn.replaceWith(fresh);
  thumbObs?.observe(fresh.querySelector('img'));
}

function pageChanged(n) {
  if (!S.doc) return;
  updatePageItem(n);
  renderHeader();
  renderBar();
  if (n === S.page) { drawOverlay(); renderInspector(); }
  else if (S.itab === 'output' && S.outWhole) renderInspector();
}

// thumbnails, made lazily and one at a time
let thumbObs = null, thumbChain = Promise.resolve();
function getThumb(n) {
  if (thumbs.has(n)) return Promise.resolve(thumbs.get(n));
  const src = S.source;
  if (!src) return Promise.resolve(null);
  thumbChain = thumbChain.then(async () => {
    if (thumbs.has(n) || S.source !== src) return;
    const c = await src.render(n, 110);
    thumbs.set(n, c.toDataURL('image/jpeg', 0.72));
    c.width = c.height = 0;
  }).catch(() => {});
  return thumbChain.then(() => thumbs.get(n) || null);
}
function observeThumbs() {
  thumbObs?.disconnect();
  if (!S.source) return;
  thumbObs = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      thumbObs.unobserve(img);
      if (img.getAttribute('src')) continue;
      getThumb(+img.dataset.thumb).then(u => { if (u) img.src = u; });
    }
  }, { root: $('#page-list'), rootMargin: '400px' });
  $$('#page-list img[data-thumb]').forEach(i => { if (!i.getAttribute('src')) thumbObs.observe(i); });
}

function goPage(n, { keepSel = false } = {}) {
  if (!S.doc) return;
  n = Math.max(1, Math.min(S.doc.pages.length, n));
  const changed = n !== S.page;
  S.page = n;
  if (!keepSel) S.sel = null;
  S.doc.lastPage = n;
  save();
  $$('#page-list .page-item.on').forEach(b => b.classList.remove('on'));
  const item = $(`#page-list [data-page="${n}"]`);
  item?.classList.add('on');
  item?.scrollIntoView({ block: 'nearest' });
  if (changed) { $('#scan-scroll').scrollTop = 0; $('#inspector').scrollTop = 0; }
  renderScan();
  renderInspector();
}

// ---------- the scan ----------

async function pageImage(n, want) {
  if (S.img && S.img.n === n && S.img.width >= want * 0.9) return S.img;
  const src = S.source;
  const c = await src.render(n, want);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
  const width = c.width;
  c.width = c.height = 0;
  if (S.source !== src || n !== S.page || !blob) return null;
  const old = S.img;
  S.img = { n, width, url: URL.createObjectURL(blob) };
  if (old) setTimeout(() => URL.revokeObjectURL(old.url), 1000);
  return S.img;
}

function stageWidth() {
  const scroll = $('#scan-scroll');
  const avail = (scroll.clientWidth || Math.min(window.innerWidth, 900)) - 28;
  return Math.max(200, Math.round(avail * S.zoom));
}

async function renderScan() {
  if (!S.doc) return;
  const p = page();
  const stage = $('#scan-stage');
  $('#scan-title').textContent = `Page ${p.n} of ${S.doc.pages.length}`;
  $('#exclude-btn').textContent = p.excluded ? 'Bring the page back' : 'Leave page out';
  $$('#overlay-seg button').forEach(b => b.classList.toggle('on', b.dataset.overlay === S.overlay));
  if (!S.source) {
    stage.style.width = ''; stage.style.aspectRatio = '';
    stage.innerHTML = `<div class="scan-empty">The original file isn’t on this phone, so the scan can’t be shown. The text is all here.<br><br>
      <label class="btn">Open the original again<input type="file" accept="application/pdf,image/*" multiple hidden data-reattach></label></div>`;
    return;
  }
  const tok = ++S.scanTok;
  const cssW = stageWidth();
  stage.style.width = cssW + 'px';
  stage.style.aspectRatio = `${p.w} / ${p.h}`;
  if (!(S.img && S.img.n === p.n)) stage.innerHTML = '';
  const want = Math.min(2600, Math.max(1200, Math.round(cssW * (window.devicePixelRatio || 2))));
  let img;
  try { img = await pageImage(p.n, want); } catch (e) { console.error(e); }
  if (tok !== S.scanTok || !img) return;
  let el = stage.querySelector('img');
  if (!el) { stage.innerHTML = ''; el = document.createElement('img'); el.alt = ''; stage.appendChild(el); }
  if (el.getAttribute('src') !== img.url) el.src = img.url;
  drawOverlay();
  updateSnips();
}

function drawOverlay() {
  if (!S.doc || !S.source) return;
  const stage = $('#scan-stage');
  const p = page();
  stage.querySelector('.boxes')?.remove();
  stage.querySelector('.scan-text')?.remove();
  if (S.overlay === 'clean' || !p.blocks.length) return;
  const f = v => (+v).toFixed(5);
  if (S.overlay === 'boxes') {
    const rects = p.blocks.map(b => {
      const [x, y, w, h] = b.rect;
      const cls = [`k-${b.kind}`, b.removed ? 'removed' : '', b.id === S.sel ? 'sel' : '', S.hitSet.has(b.id) ? 'hit' : ''].join(' ');
      return `<rect data-block="${b.id}" class="${cls}" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"/>`;
    }).join('');
    stage.insertAdjacentHTML('beforeend', `<svg class="boxes" viewBox="0 0 1 1" preserveAspectRatio="none">${rects}</svg>`);
  } else {
    const H = stageWidth() * p.h / p.w;
    const spans = p.blocks.flatMap(b => {
      const items = b.text !== b.original || !b.lines?.length ? [{ t: b.text.replace(/\n/g, ' '), r: b.rect, block: true }] : b.lines;
      return items.map(l => {
        const [x, y, w, h] = l.r;
        const lines = l.block ? Math.max(1, b.lines?.length || 1) : 1;
        const size = Math.max(6, (h * H / lines) * 0.72);
        return `<span data-block="${b.id}" class="${b.removed ? 'removed' : ''}" dir="auto" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;font-size:${size.toFixed(1)}px;${l.block ? 'white-space:normal;align-items:flex-start;line-height:1.2' : ''}">${esc(l.t)}</span>`;
      });
    }).join('');
    stage.insertAdjacentHTML('beforeend', `<div class="scan-text">${spans}</div>`);
  }
}

function revealInScan(b) {
  if (phone() || !b) return;
  const scroll = $('#scan-scroll'), stage = $('#scan-stage');
  const top = stage.offsetTop + b.rect[1] * stage.clientHeight - scroll.clientHeight / 3;
  scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

$('#scan-stage').addEventListener('click', e => {
  const t = e.target.closest('[data-block]');
  if (t) selectBlock(t.dataset.block, { reveal: true });
});
$('#scan-stage').addEventListener('change', e => {
  if (e.target.matches('[data-reattach]')) { const l = [...e.target.files]; e.target.value = ''; reattach(l); }
});
$('#overlay-seg').addEventListener('click', e => {
  const b = e.target.closest('[data-overlay]');
  if (!b) return;
  S.overlay = b.dataset.overlay;
  $$('#overlay-seg button').forEach(x => x.classList.toggle('on', x === b));
  drawOverlay();
});

// Pinch on the scan zooms the scan, never the whole app.
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());
$('#scan-scroll').addEventListener('gestureend', e => {
  e.preventDefault();
  if (!e.scale || Math.abs(e.scale - 1) < 0.08) return;
  setZoom(S.zoom * e.scale);
});
function setZoom(z) {
  S.zoom = Math.max(1, Math.min(4, Math.round(z * 4) / 4));
  renderScan();
}

// ---------- compare & correct ----------

const KIND_OPTS = [['paragraph', 'Paragraph'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['list', 'List']];
const kindVal = b => (b.kind === 'heading' ? 'h' + Math.min(3, Math.max(1, b.level || 2)) : b.kind);
const PIN_OPTS = [['', 'Document language'], ['auto', 'Automatic'], ['german', 'Deutsch'], ['arabic', 'العربية'], ['english', 'English']];

function snipStyle(b, p) {
  const px = 0.008, py = 0.008 * p.w / p.h;
  const x = Math.max(0, b.rect[0] - px), y = Math.max(0, b.rect[1] - py);
  const w = Math.min(1 - x, b.rect[2] + 2 * px), h = Math.min(1 - y, b.rect[3] + 2 * py);
  const ar = (w * p.w) / (h * p.h);
  const maxW = Math.round(Math.min(w * 560, 230 * ar));
  let s = `aspect-ratio:${ar.toFixed(4)};width:min(100%, ${Math.max(60, maxW)}px);`;
  const img = S.img && S.img.n === p.n ? S.img : null;
  if (img) s += `background-image:url(${img.url});background-size:${(100 / w).toFixed(3)}% auto;background-position:${w < 1 ? (x / (1 - w) * 100).toFixed(3) : 0}% ${h < 1 ? (y / (1 - h) * 100).toFixed(3) : 0}%;`;
  return s;
}

function updateSnips() {
  if (!S.doc) return;
  const p = page();
  $$('#inspector .snip').forEach(el => {
    const b = p.blocks.find(x => x.id === el.closest('.card')?.dataset.id);
    if (b) el.setAttribute('style', snipStyle(b, p));
  });
}

function tagsHTML(b) {
  return `${b.text !== b.original ? '<span class="tag fix">corrected</span>' : ''}${b.removed ? '<span class="tag rm">removed</span>' : ''}${S.hitSet.has(b.id) ? '<span class="tag match">match</span>' : ''}`;
}

function cardHTML(b, i, p) {
  const changed = b.text !== b.original;
  const cls = ['card', `k-${b.kind}`, b.removed ? 'removed' : '', b.id === S.sel ? 'sel' : '', S.hitSet.has(b.id) ? 'hit' : ''].filter(Boolean).join(' ');
  const short = b.text.length <= 80;
  return `<div class="${cls}" data-id="${b.id}">
    <div class="idx">${i + 1}</div>
    <div class="slip">
      <div class="slip-head">
        <select data-kind class="k-${b.removed ? 'removed' : b.kind}" aria-label="What this is">${KIND_OPTS.map(([v, l]) => `<option value="${v}"${v === kindVal(b) ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <em>${b.origin === 'ocr' ? 'read from the scan' : 'its own text'}</em>
        <span class="spacer"></span><span class="tags">${tagsHTML(b)}</span>
      </div>
      ${S.source ? `<div class="snip${isRTL(b.text) ? ' rtl' : ''}" style="${snipStyle(b, p)}"></div>` : ''}
      <textarea dir="auto" rows="1" spellcheck="false" autocorrect="off" autocapitalize="off" aria-label="Text of block ${i + 1}">${esc(b.text)}</textarea>
      <div class="slip-actions">
        <button class="btn btn-ghost" data-b="remove">${b.removed ? 'Restore' : 'Remove'}</button>
        <button class="btn btn-ghost" data-b="revert"${changed ? '' : ' hidden'}>Undo correction</button>
        <button class="btn btn-ghost" data-b="up" aria-label="Move up">↑</button>
        <button class="btn btn-ghost" data-b="down" aria-label="Move down">↓</button>
        <button class="btn btn-ghost" data-b="join">Join with next</button>
        ${short ? '<button class="btn btn-ghost" data-b="alike">Leave out all like this</button>' : ''}
        <button class="btn btn-ghost" data-b="copy">Copy</button>
      </div>
    </div>
  </div>`;
}

function updateCard(card, b) {
  card.className = ['card', `k-${b.kind}`, b.removed ? 'removed' : '', b.id === S.sel ? 'sel' : '', S.hitSet.has(b.id) ? 'hit' : ''].filter(Boolean).join(' ');
  card.querySelector('.tags').innerHTML = tagsHTML(b);
  card.querySelector('[data-kind]').className = `k-${b.removed ? 'removed' : b.kind}`;
  card.querySelector('[data-b="remove"]').textContent = b.removed ? 'Restore' : 'Remove';
  card.querySelector('[data-b="revert"]').hidden = b.text === b.original;
}

const autosize = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
function autosizeAll() {
  const insp = $('#inspector');
  if (insp.offsetParent === null) return;
  $$('textarea', insp).forEach(autosize);
}

function renderInspector() {
  if (!S.doc) return;
  const insp = $('#inspector');
  if (S.itab === 'output') return renderOutput();
  const p = page();
  const keep = S.inspPage === p.n ? insp.scrollTop : 0;
  S.inspPage = p.n;
  const reading = S.reading?.n === p.n, waiting = S.queue.includes(p.n);
  const chip = { pending: 'Not read', text: 'Its own text', ocr: 'Read from the scan', empty: 'Nothing found' }[p.source];
  const head = `<div class="insp-head"><h2>Page ${p.n}</h2><span class="chip src-${p.source}">${chip}</span>
    ${p.langs ? `<em class="faint" style="font-size:14px">${esc(LANG_NAMES[p.langs] || p.langs)}</em>` : ''}</div>`;
  const controls = S.source ? `<div class="row wrap" style="margin:0 2px 12px">
      ${reading ? '<span class="note"><span class="spin"></span> Reading this page…</span>'
        : `<button class="btn btn-small" data-action="read-page">${waiting ? 'Read this page next' : p.source === 'pending' ? 'Read this page now' : 'Read again'}</button>`}
      <select data-pin class="btn btn-small" aria-label="Language for this page">${PIN_OPTS.map(([v, l]) => `<option value="${v}"${(p.pinned || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      ${p.blocks.some(b => b.removed) ? check('hide', 'hide removed', S.hideRemoved, 'data-hide') : ''}
    </div>` : '';
  let main;
  if (p.excluded) {
    main = `<div class="placeholder"><span class="fl">❧</span>This page is left out of everything you export.<br><br><button class="btn" data-action="exclude">Bring it back</button></div>`;
  } else if (p.source === 'pending') {
    main = `<div class="placeholder"><span class="fl">❧</span>${reading ? 'Reading…' : waiting ? 'Waiting its turn.' : 'Not read yet.'}${p.error ? `<br><span class="error">${esc(p.error)}</span>` : ''}</div>`;
  } else if (!p.blocks.length) {
    main = `<div class="placeholder"><span class="fl">❧</span>No text was found on this page.</div>`;
  } else {
    const shown = p.blocks.map((b, i) => [b, i]).filter(([b]) => !(S.hideRemoved && b.removed));
    main = shown.map(([b, i]) => cardHTML(b, i, p)).join('') + '<div class="fleuron">❧</div>';
  }
  insp.innerHTML = head + controls + main;
  requestAnimationFrame(() => { autosizeAll(); insp.scrollTop = keep; });
}

function findBlock(id) {
  for (const p of S.doc.pages) {
    const i = p.blocks.findIndex(b => b.id === id);
    if (i >= 0) return { p, b: p.blocks[i], i };
  }
  return {};
}

function selectBlock(id, { reveal = false, scan = false } = {}) {
  S.sel = id;
  $$('#inspector .card').forEach(c => c.classList.toggle('sel', c.dataset.id === id));
  $$('#scan-stage rect[data-block]').forEach(r => r.classList.toggle('sel', r.dataset.block === id));
  const { b } = findBlock(id);
  if (scan) revealInScan(b);
  if (reveal) {
    if (phone()) setTab('text');
    if (S.itab !== 'blocks') setITab('blocks');
    let card = $(`#inspector .card[data-id="${id}"]`);
    if (!card && S.hideRemoved) { S.hideRemoved = false; renderInspector(); card = $(`#inspector .card[data-id="${id}"]`); }
    requestAnimationFrame(() => card?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    revealInScan(b);
  }
}

function commitText(id, v) {
  const { p, b } = findBlock(id);
  if (!b || v === b.text) return;
  snapshot('correction');
  b.text = v;
  save();
  const card = $(`#inspector .card[data-id="${id}"]`);
  if (card) updateCard(card, b);
  if (p.n === S.page) drawOverlay();
  updatePageItem(p.n);
  renderHeader();
}

function setKind(id, v) {
  const { p, b } = findBlock(id);
  if (!b) return;
  snapshot('kind');
  if (v.startsWith('h')) { b.kind = 'heading'; b.level = +v[1]; }
  else { b.kind = v; b.level = 0; }
  if (v === 'list' && !/^\s*[-*•]/.test(b.text)) b.text = b.text.split('\n').map(l => '- ' + l.trim()).join('\n');
  p.cols = columnCount(p.blocks);
  save();
  renderInspector();
  drawOverlay();
}

const likePattern = t => norm(t).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

async function blockAction(id, act) {
  const { p, b, i } = findBlock(id);
  if (!b) return;
  const card = $(`#inspector .card[data-id="${id}"]`);
  switch (act) {
    case 'remove':
      snapshot(b.removed ? 'restore' : 'remove');
      b.removed = !b.removed;
      if (S.hideRemoved && b.removed) renderInspector(); else if (card) updateCard(card, b);
      break;
    case 'revert':
      snapshot('undo correction');
      b.text = b.original;
      if (card) { const ta = card.querySelector('textarea'); ta.value = b.text; autosize(ta); updateCard(card, b); }
      break;
    case 'up': case 'down': {
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= p.blocks.length) return;
      snapshot('move');
      [p.blocks[i], p.blocks[j]] = [p.blocks[j], p.blocks[i]];
      renderInspector();
      requestAnimationFrame(() => $(`#inspector .card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
      break;
    }
    case 'join': {
      const next = p.blocks[i + 1];
      if (!next) return toast('This is the last block on the page.');
      snapshot('join');
      const sep = b.kind === 'list' || next.kind === 'list' ? '\n' : ' ';
      b.text = b.text + sep + next.text;
      b.original = b.original + sep + next.original;
      const x0 = Math.min(b.rect[0], next.rect[0]), y0 = Math.min(b.rect[1], next.rect[1]);
      const x1 = Math.max(b.rect[0] + b.rect[2], next.rect[0] + next.rect[2]), y1 = Math.max(b.rect[1] + b.rect[3], next.rect[1] + next.rect[3]);
      b.rect = [x0, y0, x1 - x0, y1 - y0];
      b.lines = [...(b.lines || []), ...(next.lines || [])];
      p.blocks.splice(i + 1, 1);
      p.cols = columnCount(p.blocks);
      renderInspector();
      break;
    }
    case 'alike': {
      const pat = likePattern(b.text);
      let n = 0;
      snapshot('leave out all like this');
      for (const pg of S.doc.pages) for (const x of pg.blocks) {
        if (!x.removed && likePattern(x.text) === pat) { x.removed = true; n++; }
      }
      if (!n) { S.undo.pop(); return toast('Nothing else like it.'); }
      renderInspector();
      S.doc.pages.forEach(pg => updatePageItem(pg.n));
      toast(`Left out ${n} like this, on every page`);
      break;
    }
    case 'copy':
      return copyText(b.text);
  }
  save();
  drawOverlay();
  updatePageItem(p.n);
  renderHeader();
}

const insp = $('#inspector');
insp.addEventListener('input', e => { if (e.target.matches('textarea')) autosize(e.target); });
insp.addEventListener('change', e => {
  const t = e.target, card = t.closest('.card');
  if (t.matches('textarea') && card) commitText(card.dataset.id, t.value);
  else if (t.matches('[data-kind]') && card) setKind(card.dataset.id, t.value);
  else if (t.matches('[data-pin]')) {
    const p = page();
    p.pinned = t.value || null;
    save();
    if (p.source !== 'pending' && isStale(p)) readAgain([p.n], 'reading in another language');
    else { renderBar(); updatePageItem(p.n); }
  } else if (t.matches('[data-hide]')) { S.hideRemoved = t.checked; renderInspector(); }
});
insp.addEventListener('focusin', e => {
  const card = e.target.closest('.card');
  if (card && e.target.matches('textarea') && S.sel !== card.dataset.id) selectBlock(card.dataset.id, { scan: true });
});
insp.addEventListener('click', e => {
  const btn = e.target.closest('[data-b]');
  if (btn) return blockAction(btn.closest('.card').dataset.id, btn.dataset.b);
  const out = e.target.closest('[data-out]');
  if (out) { S.outWhole = out.dataset.out === 'all'; return renderOutput(); }
  const card = e.target.closest('.card');
  if (card && !e.target.closest('textarea, select, button')) selectBlock(card.dataset.id, { scan: true });
});

function outputText(whole = S.outWhole) {
  return renderText(whole ? S.doc.pages : [page()], { title: title(), source: S.doc.name, options: S.doc.export, single: !whole });
}

function renderOutput() {
  const text = outputText();
  const st = stats(text);
  insp.innerHTML = `<div class="output">
    <div class="row wrap">
      <div class="seg"><button data-out="all" class="${S.outWhole ? 'on' : ''}">Whole file</button><button data-out="page" class="${S.outWhole ? '' : 'on'}">This page</button></div>
      <span class="spacer"></span>
      <button class="btn btn-small" data-action="copy-output">Copy</button>
      <button class="btn btn-small btn-ink" data-action="export">Export…</button>
    </div>
    <p class="note">${st.words} words · written as ${S.doc.export.format === 'markdown' ? 'Markdown' : 'plain text'}, with your export choices</p>
    <pre>${esc(text)}</pre></div>`;
}

function setITab(t) {
  S.itab = t;
  $$('#text-panel [data-itab]').forEach(b => b.classList.toggle('on', b.dataset.itab === t));
  renderInspector();
}
$('#text-panel .tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-itab]');
  if (b) setITab(b.dataset.itab);
});

function setTab(t, render = true) {
  body.dataset.tab = t;
  $$('#tabbar [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  if (!render || !S.doc) return;
  if (t === 'scan') renderScan();
  if (t === 'text') requestAnimationFrame(autosizeAll);
  if (t === 'pages') $(`#page-list [data-page="${S.page}"]`)?.scrollIntoView({ block: 'center' });
}
$('#tabbar').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

$('#page-list').addEventListener('click', e => {
  const b = e.target.closest('[data-page]');
  if (!b) return;
  goPage(+b.dataset.page);
  if (phone()) setTab('scan');
});

// ---------- search ----------

const runSearch = debounce(() => {
  if (!S.doc) return;
  const q = norm($('#search-input').value.trim());
  S.hits = [];
  if (q) for (const p of S.doc.pages) for (const b of p.blocks) if (norm(b.text).includes(q)) S.hits.push({ page: p.n, block: b.id });
  S.hitSet = new Set(S.hits.map(h => h.block));
  S.hitIdx = -1;
  $('#search-count').textContent = q ? (S.hits.length ? `${S.hits.length}` : 'none') : '';
  renderPageList();
  drawOverlay();
  if (S.itab === 'blocks') renderInspector();
}, 220);
$('#search-input').addEventListener('input', runSearch);
$('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); stepHit(1); } });

function stepHit(d) {
  if (!S.hits.length) return;
  S.hitIdx = (S.hitIdx + d + S.hits.length) % S.hits.length;
  const h = S.hits[S.hitIdx];
  $('#search-count').textContent = `${S.hitIdx + 1} of ${S.hits.length}`;
  if (h.page !== S.page) goPage(h.page);
  selectBlock(h.block, { reveal: true });
}

function toggleSearch() {
  const row = $('#search-row');
  row.hidden = !row.hidden;
  if (!row.hidden) $('#search-input').focus();
  else { $('#search-input').value = ''; runSearch(); }
}

// ---------- export ----------

function exportSheet() {
  const o = S.doc.export;
  const el = openSheet(`${sheetHead('Export', S.doc.name)}<div class="sheet-body" id="x-body"></div>
    <div class="sheet-foot"><button class="btn" data-copy>Copy</button><span class="spacer"></span><button class="btn btn-ink" data-save>Save file…</button></div>`, { cls: 'tall' });
  const bodyEl = el.querySelector('#x-body');
  const text = () => renderText(S.doc.pages, { title: title(), source: S.doc.name, options: o });
  const preview = debounce(() => {
    const t = text(), st = stats(t);
    bodyEl.querySelector('#x-prev').textContent = t.length > 12000 ? t.slice(0, 12000) + '\n…' : t;
    bodyEl.querySelector('#x-stats').textContent = `· ${st.words} words`;
  }, 120);
  const rulesHTML = () => o.rules.map((r, i) => `<div class="group" style="margin-bottom:10px" data-r="${i}">
      <div class="rule-row">
        <input type="checkbox" data-rk="enabled" ${r.enabled ? 'checked' : ''} aria-label="Use this rule" style="width:20px;height:20px;accent-color:var(--accent)">
        <input data-rk="find" value="${esc(r.find)}" placeholder="${r.action === 'removeLine' ? 'Lines containing' : 'Find'}" autocapitalize="off" autocorrect="off">
        ${r.action === 'replace' ? `<input data-rk="replace" value="${esc(r.replace)}" placeholder="Replace with" autocapitalize="off" autocorrect="off">` : '<span class="note" style="margin:0">removed</span>'}
        <button class="icon-btn small" data-rdel aria-label="Delete rule">${ICON.x}</button>
      </div>
      <div class="row wrap">
        <select data-rk="action" class="btn btn-small"><option value="replace"${r.action === 'replace' ? ' selected' : ''}>Replace</option><option value="removeLine"${r.action === 'removeLine' ? ' selected' : ''}>Remove the line</option></select>
        <label class="check" style="min-height:36px"><input type="checkbox" data-rk="regex" ${r.regex ? 'checked' : ''}> pattern</label>
        <label class="check" style="min-height:36px"><input type="checkbox" data-rk="caseSensitive" ${r.caseSensitive ? 'checked' : ''}> match case</label>
        ${r.find && !ruleRegex(r) ? '<span class="error">not a valid pattern</span>' : ''}
      </div></div>`).join('') || '<p class="note">Rules change the exported text only, never your corrections. E.g. remove a running header, or swap ſ for s.</p>';
  const draw = () => {
    bodyEl.innerHTML = `
      <div class="preset-row">${PRESETS.map((p, i) => `<button class="btn btn-small" data-preset="${i}">${p.name}</button>`).join('')}</div>
      <div class="cols2">
        <div>
          <div class="group"><h3>Format</h3><div class="seg full"><button data-fmt="markdown" class="${o.format === 'markdown' ? 'on' : ''}">Markdown</button><button data-fmt="plain" class="${o.format === 'plain' ? 'on' : ''}">Plain text</button></div></div>
          <div class="group"><h3>Where pages begin</h3>
            <label class="field"><select data-k="pageMarker">${MARKERS.map(([v, l]) => `<option value="${v}"${o.pageMarker === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
            ${o.pageMarker !== 'none' ? `<label class="field">Label, {n} is the number<input data-k="markerText" value="${esc(o.markerText)}" autocapitalize="off"></label>` : ''}
          </div>
          <div class="group"><h3>Headings</h3><label class="field"><select data-k="headings">${HEADINGS.map(([v, l]) => `<option value="${v}"${o.headings === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>
          <div class="group"><h3>Tidying</h3>
            ${check('joinHyphens', 'Join words broken at line ends', o.joinHyphens)}
            ${check('dropPageNumbers', 'Leave out page numbers', o.dropPageNumbers)}
            ${check('unifyQuotes', 'Plain straight quotes', o.unifyQuotes)}
            ${check('keepLists', 'Keep lists as lists', o.keepLists)}
            ${check('airy', 'Blank line between paragraphs', o.spacing === 'airy')}
            ${check('rtlMarks', 'Mark Arabic lines right-to-left', o.rtlMarks)}
            ${check('includeSkipped', 'Include what was left out', o.includeSkipped)}
            <label class="field">Wrap lines<select data-k="wrapColumn">${[0, 72, 80, 100].map(v => `<option value="${v}"${o.wrapColumn === v ? ' selected' : ''}>${v ? `at ${v} characters` : 'Don’t wrap'}</option>`).join('')}</select></label>
          </div>
          <div class="group"><h3>Top of the file</h3>
            ${check('addTitle', 'Title at the top', o.addTitle)}
            ${o.addTitle ? `<label class="field"><input data-k="title" value="${esc(o.title)}" placeholder="${esc(title())}"></label>` : ''}
            ${o.format === 'markdown' ? check('frontMatter', 'Front matter (title, source, date)', o.frontMatter) : ''}
          </div>
        </div>
        <div>
          <div class="group"><h3>Clean-up rules</h3><div id="x-rules">${rulesHTML()}</div><button class="btn btn-small" data-addrule>Add a rule</button></div>
          <div class="group"><h3>Preview <span id="x-stats" class="faint" style="font-size:15px"></span></h3><pre class="preview" id="x-prev"></pre></div>
        </div>
      </div>`;
    preview();
  };
  const edited = () => { save(); preview(); if (S.itab === 'output') renderOutput(); };
  bodyEl.addEventListener('click', e => {
    const pr = e.target.closest('[data-preset]');
    if (pr) { Object.assign(o, defaultExport(), { rules: o.rules }, PRESETS[+pr.dataset.preset].options); draw(); edited(); toast(PRESETS[+pr.dataset.preset].name); return; }
    const f = e.target.closest('[data-fmt]');
    if (f) { o.format = f.dataset.fmt; draw(); edited(); return; }
    if (e.target.closest('[data-addrule]')) { o.rules.push({ enabled: true, action: 'replace', find: '', replace: '', regex: false, caseSensitive: false }); bodyEl.querySelector('#x-rules').innerHTML = rulesHTML(); return; }
    const del = e.target.closest('[data-rdel]');
    if (del) { o.rules.splice(+del.closest('[data-r]').dataset.r, 1); bodyEl.querySelector('#x-rules').innerHTML = rulesHTML(); edited(); }
  });
  const onField = (e, final) => {
    const t = e.target;
    const k = t.dataset.k;
    if (k) {
      if (k === 'airy') o.spacing = t.checked ? 'airy' : 'compact';
      else if (t.type === 'checkbox') o[k] = t.checked;
      else if (k === 'wrapColumn') o[k] = +t.value;
      else o[k] = t.value;
      if (final && ['pageMarker', 'addTitle'].includes(k)) draw();
      edited();
      return;
    }
    const rk = t.dataset.rk;
    if (rk) {
      const r = o.rules[+t.closest('[data-r]').dataset.r];
      r[rk] = t.type === 'checkbox' ? t.checked : t.value;
      if (final && (rk === 'action' || rk === 'regex' || rk === 'find')) bodyEl.querySelector('#x-rules').innerHTML = rulesHTML();
      edited();
    }
  };
  bodyEl.addEventListener('input', e => { if (e.target.type !== 'checkbox' && e.target.tagName === 'INPUT') onField(e, false); });
  bodyEl.addEventListener('change', e => onField(e, true));
  el.querySelector('[data-copy]').onclick = () => copyText(text());
  el.querySelector('[data-save]').onclick = () => saveBlob(`${title()}.${o.format === 'markdown' ? 'md' : 'txt'}`, new Blob([text()], { type: 'text/plain' }));
  draw();
}

// ---------- find & replace ----------

function findSheet() {
  const r = { find: $('#search-input').value || '', replace: '', regex: false, caseSensitive: false, pageOnly: false };
  const el = openSheet(`${sheetHead('Find & replace', 'Changes the text itself, and can be undone')}
    <div class="sheet-body">
      <label class="field">Find<input data-f="find" value="${esc(r.find)}" autocapitalize="off" autocorrect="off" dir="auto"></label>
      <label class="field">Replace with<input data-f="replace" autocapitalize="off" autocorrect="off" dir="auto"></label>
      ${check('regex', 'Pattern (regular expression)', false, 'data-f')}
      ${check('caseSensitive', 'Match case', false, 'data-f')}
      ${check('pageOnly', 'This page only', false, 'data-f')}
      <p class="note" id="f-count"></p>
    </div>
    <div class="sheet-foot"><button class="btn" data-rule>Keep as an export rule</button><span class="spacer"></span><button class="btn btn-ink" data-all>Replace all</button></div>`, { cls: 'narrow' });
  const target = () => (r.pageOnly ? [page()] : S.doc.pages).flatMap(p => p.blocks.filter(b => !b.removed));
  const count = () => {
    const out = el.querySelector('#f-count');
    if (!r.find) { out.textContent = ''; return 0; }
    const re = ruleRegex(r, true);
    if (!re) { out.textContent = 'That isn’t a valid pattern.'; return 0; }
    let n = 0;
    for (const b of target()) n += (b.text.match(re) || []).length;
    out.textContent = n ? `${n} match${n === 1 ? '' : 'es'}` : 'No matches';
    return n;
  };
  el.addEventListener('input', e => {
    const k = e.target.dataset.f;
    if (!k) return;
    r[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    count();
  });
  el.querySelector('[data-all]').onclick = () => {
    if (!count()) return;
    const re = ruleRegex(r, true);
    const rep = r.regex ? r.replace : r.replace.replace(/\$/g, '$$$$');
    snapshot('replace');
    let n = 0;
    for (const b of target()) {
      const t = b.text.replace(re, rep);
      if (t !== b.text) { b.text = t; n++; }
    }
    save(); closeSheet(); renderAll();
    toast(`Replaced in ${n} block${n === 1 ? '' : 's'}`);
  };
  el.querySelector('[data-rule]').onclick = () => {
    if (!r.find) return;
    S.doc.export.rules.push({ enabled: true, action: 'replace', find: r.find, replace: r.replace, regex: r.regex, caseSensitive: r.caseSensitive });
    save(); closeSheet();
    toast('Added to the export rules');
  };
  count();
  setTimeout(() => el.querySelector('[data-f="find"]').focus(), 250);
}

// ---------- words ----------

function wordsSheet() {
  const o = S.doc.words;
  let tab = 'words', sel = null, list = [], filter = '';
  const el = openSheet(`${sheetHead('Words', S.doc.name)}<div class="sheet-body" id="w-body"></div>
    <div class="sheet-foot"><button class="btn" data-csv>Save as CSV…</button><span class="spacer"></span><button class="btn btn-ink" data-close>Done</button></div>`, { cls: 'tall' });
  const bodyEl = el.querySelector('#w-body');
  const compute = () => { list = tab === 'words' ? frequencies(S.doc.pages, o) : tab === 'phrases' ? phrases(S.doc.pages, o) : []; };
  const listHTML = () => {
    if (sel) {
      const ctx = contexts(sel, S.doc.pages, o, 80);
      return `<button class="btn btn-ghost btn-small" data-back>‹ All ${tab}</button>
        <h3 style="font-weight:400;font-size:26px;margin:6px 0 2px" dir="auto">${esc(sel.shown)}</h3>
        <p class="note">${sel.count} time${sel.count === 1 ? '' : 's'}, on page${sel.pages.length === 1 ? '' : 's'} ${sel.pages.slice(0, 30).join(', ')}${sel.pages.length > 30 ? '…' : ''}</p>
        ${ctx.map(c => `<div class="ctx" dir="${c.rtl ? 'rtl' : 'ltr'}"><button class="btn btn-ghost btn-small pg" data-goto="${c.page}" data-block="${c.block}">p. ${c.page}</button>…${esc(c.before)}<mark>${esc(c.match)}</mark>${esc(c.after)}…</div>`).join('')}`;
    }
    const q = norm(filter.trim());
    const shown = (q ? list.filter(w => w.key.includes(q)) : list).slice(0, 400);
    const max = list[0]?.count || 1;
    if (!list.length) return `<p class="placeholder">${tab === 'phrases' ? 'No phrase comes up more than once yet.' : 'No words yet. Read some pages first.'}</p>`;
    return `<ol class="word-list">${shown.map(w => `<li><button data-w="${esc(w.key)}"><span class="rank">${list.indexOf(w) + 1}</span><span><span class="w" dir="auto">${esc(w.shown)}</span><span class="bar" style="width:${Math.max(2, (w.count / max) * 100)}%"></span></span><span class="c">${w.count}</span></button></li>`).join('')}</ol>
      ${list.length > shown.length && !q ? `<p class="note">The first 400 of ${list.length}. Filter to find the rest, or save the CSV for all.</p>` : ''}`;
  };
  const statsHTML = () => {
    const st = docStats(S.doc.pages, o);
    const max = Math.max(1, ...st.perPage.map(p => p.words));
    return `<div class="stats-grid">
      <div class="stat"><b>${st.words.toLocaleString()}</b><span>words</span></div>
      <div class="stat"><b>${st.unique.toLocaleString()}</b><span>different words</span></div>
      <div class="stat"><b>${Math.max(1, Math.round(st.minutes))}</b><span>minutes to read</span></div>
      <div class="stat"><b>${Math.round(st.variety * 100)}%</b><span>variety</span></div>
      <div class="stat"><b>${st.averageLength.toFixed(1)}</b><span>letters a word</span></div>
      <div class="stat"><b>${Math.round(st.arabicShare * 100)}%</b><span>in Arabic script</span></div>
    </div>
    <h3 style="font-weight:400;margin:22px 0 0">Words on each page</h3>
    <div class="spark">${st.perPage.map(p => `<i style="height:${(p.words / max) * 100}%" title="p. ${p.page}: ${p.words}"></i>`).join('')}</div>
    ${st.longest.length ? `<h3 style="font-weight:400;margin:18px 0 6px">Longest words</h3><p dir="auto">${st.longest.map(esc).join(' · ')}</p>` : ''}`;
  };
  const draw = () => {
    bodyEl.innerHTML = `<div class="seg full" style="margin-bottom:12px">${[['words', 'Words'], ['phrases', 'Phrases'], ['stats', 'Numbers']].map(([v, l]) => `<button data-wt="${v}" class="${tab === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${tab === 'stats' ? statsHTML() : `
        <div class="row wrap">
          ${check('dropCommon', 'Skip common words', o.dropCommon)}
          ${check('ignoreCase', 'Ignore case', o.ignoreCase)}
          ${check('stripTashkeel', 'Ignore tashkeel', o.stripTashkeel)}
        </div>
        ${tab === 'phrases' ? `<div class="seg" style="margin:4px 0 8px">${[2, 3, 4].map(n => `<button data-pl="${n}" class="${o.phraseLength === n ? 'on' : ''}">${n} words</button>`).join('')}</div>` : ''}
        <input class="text" type="search" id="w-filter" placeholder="Filter" value="${esc(filter)}" autocomplete="off" style="margin:6px 0 8px" dir="auto">
        <div id="w-list">${listHTML()}</div>`}`;
    el.querySelector('[data-csv]').hidden = tab === 'stats';
  };
  bodyEl.addEventListener('click', e => {
    const t = e.target.closest('[data-wt]');
    if (t) { tab = t.dataset.wt; sel = null; filter = ''; compute(); draw(); return; }
    const pl = e.target.closest('[data-pl]');
    if (pl) { o.phraseLength = +pl.dataset.pl; save(); sel = null; compute(); draw(); return; }
    const w = e.target.closest('[data-w]');
    if (w) { sel = list.find(x => x.key === w.dataset.w); bodyEl.querySelector('#w-list').innerHTML = listHTML(); bodyEl.scrollTop = 0; return; }
    if (e.target.closest('[data-back]')) { sel = null; bodyEl.querySelector('#w-list').innerHTML = listHTML(); return; }
    const g = e.target.closest('[data-goto]');
    if (g) { closeSheet(); goPage(+g.dataset.goto); selectBlock(g.dataset.block, { reveal: true }); }
  });
  bodyEl.addEventListener('change', e => {
    const k = e.target.dataset.k;
    if (!k) return;
    o[k] = e.target.checked; save(); sel = null; compute(); draw();
  });
  bodyEl.addEventListener('input', e => {
    if (e.target.id !== 'w-filter') return;
    filter = e.target.value; sel = null;
    bodyEl.querySelector('#w-list').innerHTML = listHTML();
  });
  el.querySelector('[data-csv]').onclick = () => saveBlob(`${title()} ${tab}.csv`, new Blob([csv(list, S.doc.pages, o)], { type: 'text/csv' }));
  compute(); draw();
}

// ---------- the edition ----------

function editionSheet() {
  const o = S.doc.edition;
  const el = openSheet(`${sheetHead('The Edition', 'The text set as a small book')}
    <div class="sheet-body">
      <iframe class="edition-frame" title="Preview of the edition" sandbox="allow-same-origin"></iframe>
      <div class="cols2" style="margin-top:16px">
        <div>
          <div class="group"><h3>Page</h3><div class="seg full">${['A5', 'A4', 'Letter'].map(v => `<button data-ed="page" data-v="${v}" class="${o.page === v ? 'on' : ''}">${v}</button>`).join('')}</div></div>
          <div class="group"><h3>Type</h3><div class="seg full">${[['regular', 'Regular'], ['large', 'Large']].map(([v, l]) => `<button data-ed="type" data-v="${v}" class="${o.type === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          <label class="field">Title<input data-t="title" value="${esc(o.title)}" placeholder="${esc(S.doc.name.replace(/\.[^.]+$/, ''))}" dir="auto"></label>
          <label class="field">Subtitle<input data-t="subtitle" value="${esc(o.subtitle)}" placeholder="Optional" dir="auto"></label>
        </div>
        <div class="group"><h3>Setting</h3>
          ${check('keepColumns', 'Keep two columns where the scan had them', o.keepColumns)}
          ${check('titlePage', 'Title page', o.titlePage)}
          ${check('marginNotes', 'Source page in the margin', o.marginNotes)}
          ${check('runningHeads', 'Title at the top of printed pages', o.runningHeads)}
          ${check('justify', 'Justified lines', o.justify)}
          ${check('paperTint', 'Warm paper tint', o.paperTint)}
          ${check('colophon', 'A colophon at the end', o.colophon)}
        </div>
      </div>
    </div>
    <div class="sheet-foot"><button class="btn" data-html>Save as a web page…</button><button class="btn" data-epub>E-book…</button><span class="spacer"></span><button class="btn btn-ink" data-print>Print or save as PDF</button></div>`, { cls: 'tall' });
  const frame = el.querySelector('iframe');
  const update = debounce(() => { frame.srcdoc = editionDocument(S.doc, o); }, 250);
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-ed]');
    if (!b) return;
    o[b.dataset.ed] = b.dataset.v;
    $$(`[data-ed="${b.dataset.ed}"]`, el).forEach(x => x.classList.toggle('on', x === b));
    save(); update();
  });
  el.addEventListener('change', e => { const k = e.target.dataset.k; if (k) { o[k] = e.target.checked; save(); update(); } });
  el.addEventListener('input', e => { const k = e.target.dataset.t; if (k) { o[k] = e.target.value; save(); update(); } });
  el.querySelector('[data-print]').onclick = () => {
    $('#print-root').innerHTML = `<style>${editionCSS(o)}</style>${editionBody(S.doc, o)}`;
    setTimeout(() => window.print(), 60);
  };
  el.querySelector('[data-epub]').onclick = () => epubSheet();
  el.querySelector('[data-html]').onclick = () => saveBlob(`${title()} (edition).html`, new Blob([editionDocument(S.doc, o)], { type: 'text/html' }));
  frame.srcdoc = editionDocument(S.doc, o);
}

// ---------- e-book ----------

function epubSheet() {
  const o = S.doc.epub, ed = S.doc.edition;
  const kept = S.doc.pages.filter(p => !p.excluded && (p.blocks || []).some(b => !b.removed)).length;
  const el = openSheet(`${sheetHead('E-book', 'EPUB for Books, Kobo and Kindle')}
    <div class="sheet-body">
      <label class="field">Title<input data-et="title" value="${esc(ed.title)}" placeholder="${esc(S.doc.name.replace(/\.[^.]+$/, ''))}" dir="auto"></label>
      <label class="field">Subtitle<input data-et="subtitle" value="${esc(ed.subtitle)}" placeholder="Optional" dir="auto"></label>
      <label class="field">Author<input data-t="author" value="${esc(o.author)}" placeholder="Optional" dir="auto"></label>
      <div class="group"><h3>Chapters</h3>${radios('chapters', [
        { id: 'auto', label: 'Let Folio choose', detail: 'At the main headings when there are some, otherwise one per page' },
        { id: 'headings', label: 'At each main heading' },
        { id: 'pages', label: 'One per page of the scan' },
        { id: 'one', label: 'All in one' },
      ], o.chapters)}</div>
      <div class="group"><h3>Setting</h3>
        ${check('cover', 'A cover, set in the Folio manner', o.cover)}
        ${check('pageMarks', 'Show where each scan page begins', o.pageMarks)}
        ${check('colophon', 'A colophon at the end', ed.colophon, 'data-ek')}
      </div>
      <p class="hint">Page numbers from the scan travel with the book either way — Books shows them as print pages. ${kept} page${kept === 1 ? '' : 's'} with text go in; removed text and left-out pages stay out.</p>
    </div>
    <div class="sheet-foot"><span class="spacer"></span><button class="btn btn-ink" data-make ${kept ? '' : 'disabled'}>Make the e-book</button></div>`, { cls: 'tall' });
  el.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.k) o[t.dataset.k] = t.checked;
    else if (t.dataset.ek) ed[t.dataset.ek] = t.checked;
    save();
  });
  el.addEventListener('click', e => {
    const r = e.target.closest('[data-radio="chapters"]');
    if (!r) return;
    o.chapters = r.dataset.val;
    $$('[data-radio="chapters"]', el).forEach(x => x.classList.toggle('on', x === r));
    save();
  });
  el.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.t) o[t.dataset.t] = t.value;
    if (t.dataset.et) ed[t.dataset.et] = t.value;
    save();
  });
  el.querySelector('[data-make]').onclick = async () => {
    try {
      const { blob, chapters } = await makeEPUB(S.doc, o);
      offerFile(`${title()}.epub`, blob, `${chapters} chapter${chapters === 1 ? '' : 's'} · ${fmtSize(blob.size)}`);
    } catch (e) {
      console.error(e);
      toast('Couldn’t make the e-book: ' + e.message, 4000);
    }
  };
}

// ---------- copyable PDF ----------

async function searchablePDF() {
  if (!S.source || !S.files) return toast('Open the original file again first.', 3000);
  const n = S.doc.pages.filter(p => p.source === 'ocr').length;
  if (!n) return toast(S.doc.pages.some(p => p.source === 'text') ? 'This PDF already has its own text you can copy.' : 'Read some pages first.', 3500);
  closeSheet();
  toast('Making the PDF…', 120000);
  try {
    const { makeSearchablePDF } = await import('./searchable.js');
    const { bytes, lines } = await makeSearchablePDF(S.doc, S.source, S.files, k => toast(`Making the PDF… page ${k}`, 120000));
    $('#toast').hidden = true;
    offerFile(`${title()} (searchable).pdf`, new Blob([bytes], { type: 'application/pdf' }), `looks like the scan; ${lines} lines on ${n} page${n === 1 ? '' : 's'} can be searched and copied`);
  } catch (e) {
    console.error(e);
    toast('Couldn’t make the PDF: ' + e.message, 4000);
  }
}

// ---------- menu ----------

function menuSheet() {
  const u = S.undo.at(-1), r = S.redo.at(-1);
  const el = openSheet(`${sheetHead(S.doc.name)}<ul class="menu-list">
    <li><button data-m="undo" ${u ? '' : 'disabled'}>Undo<small>${esc(u?.label || '')}</small></button></li>
    <li><button data-m="redo" ${r ? '' : 'disabled'}>Redo<small>${esc(r?.label || '')}</small></button></li>
    <hr>
    <li><button data-m="find">Find &amp; replace</button></li>
    <li><button data-m="words">Words &amp; phrases</button></li>
    <li><button data-m="edition">The Edition<small>a small book to print</small></button></li>
    <li><button data-m="epub">E-book<small>EPUB for Books &amp; Kindle</small></button></li>
    <li><button data-m="pdf">Copyable PDF<small>looks like the scan</small></button></li>
    <li><button data-m="export">Export text</button></li>
    <hr>
    <li><button data-m="settings">Reading settings</button></li>
    <li><button data-m="again" ${S.source ? '' : 'disabled'}>Read every page again</button></li>
    <li><button data-m="appearance">Appearance</button></li>
    <li><label class="menu-open"><input type="file" accept="application/pdf,image/*" multiple hidden data-m-open>Open another file</label></li>
    <hr>
    <li><button data-m="forget" class="danger">Forget this file</button></li>
  </ul>`, { cls: 'narrow' });
  el.addEventListener('change', e => {
    if (!e.target.matches('[data-m-open]')) return;
    const l = [...e.target.files];
    closeSheet();
    closeDoc().then(() => openFiles(l));
  });
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-m]');
    if (!b || b.disabled) return;
    const m = b.dataset.m;
    if (m === 'undo') { closeSheet(); return undo(); }
    if (m === 'redo') { closeSheet(); return redo(); }
    if (m === 'find') return findSheet();
    if (m === 'words') return wordsSheet();
    if (m === 'edition') return editionSheet();
    if (m === 'pdf') return searchablePDF();
    if (m === 'epub') return epubSheet();
    if (m === 'export') return exportSheet();
    if (m === 'settings') return settingsSheet('live');
    if (m === 'appearance') return appearanceSheet();
    if (m === 'again') {
      const ns = S.doc.pages.filter(p => !p.excluded).map(p => p.n);
      if (!await confirmSheet('Read every page again?', `All ${ns.length} pages are read afresh with ${ocrSummary(S.doc.ocr)}. Corrections are replaced; Undo brings them back.`, 'Read again')) return;
      snapshot('reading everything again');
      ns.forEach(n => { page(n).error = null; });
      enqueue(ns);
      return;
    }
    if (m === 'forget') {
      if (!await confirmSheet('Forget this file?', `“${S.doc.name}”, its text and your corrections are removed from this phone. This can’t be undone.`, 'Forget', true)) return;
      const id = S.doc.id;
      await closeDoc();
      await Store.forget(id);
      renderRecents();
      toast('Forgotten');
    }
  });
}

// ---------- actions ----------

function toggleExclude() {
  const p = page();
  snapshot(p.excluded ? 'bring page back' : 'leave page out');
  p.excluded = !p.excluded;
  if (p.excluded) S.queue = S.queue.filter(n => n !== p.n);
  save();
  renderPageList(); renderScan(); renderInspector(); renderHeader(); renderBar();
  toast(p.excluded ? `Page ${p.n} is left out` : `Page ${p.n} is back`);
}

async function act(a) {
  switch (a) {
    case 'close': return closeDoc();
    case 'search-toggle': return toggleSearch();
    case 'settings': return settingsSheet('live');
    case 'menu': return menuSheet();
    case 'export': return exportSheet();
    case 'hit-prev': return stepHit(-1);
    case 'hit-next': return stepHit(1);
    case 'zoom-in': return setZoom(S.zoom + 0.5);
    case 'zoom-out': return setZoom(S.zoom - 0.5);
    case 'page-prev': return goPage(S.page - 1);
    case 'page-next': return goPage(S.page + 1);
    case 'exclude': return toggleExclude();
    case 'stop': return stopReading();
    case 'read-unread': return enqueue(unread());
    case 'read-stale': return readAgain(staleOnes(), 'reading again');
    case 'read-page': {
      const p = page();
      if (p.source === 'pending' || p.error) { p.error = null; return enqueue([p.n], { front: true }); }
      return readAgain([p.n], 'reading the page again');
    }
    case 'copy-output': return copyText(outputText());
    case 'backup-export': return exportBackup();
    case 'appearance': return appearanceSheet();
  }
}
document.addEventListener('click', e => {
  const a = e.target.closest('[data-action]');
  if (a && !a.disabled) act(a.dataset.action);
});

// Keyboard, for iPad keyboards and computers.
document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape' && !$('#sheet').hidden) return closeSheet();
  if (!S.doc || body.dataset.view !== 'workspace') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); if ($('#search-row').hidden) toggleSearch(); else $('#search-input').focus(); return; }
  if (typing || !$('#sheet').hidden) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (e.key === 'ArrowRight' || e.key === 'PageDown') return goPage(S.page + 1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') return goPage(S.page - 1);
});

window.addEventListener('resize', debounce(() => {
  if (!S.doc) return;
  renderScan();
  autosizeAll();
}, 200));

window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  if (e.reason?.name === 'AbortError') return;
  toast('Something went wrong: ' + (e.reason?.message || e.reason), 4000);
});

// ---------- start ----------

applyAppearance();
renderRecents();
engineNote();
Store.persist();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) toast('A new version of Folio is ready. It opens next time.', 4000);
      });
    });
  }).catch(e => console.warn('Offline use isn’t available:', e));
}
