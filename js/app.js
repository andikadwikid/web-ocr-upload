import {
  buildExportRows,
  cardStatus,
  classifyFile,
  fileKey,
  formatBytes,
  formatDuration,
  lowestConfidence,
  normalizeCardValue,
  parseManualNumbers,
  toCSV,
  toTSV,
} from './lib.js';
import { createScanner } from './scanner.js';

// ---------------------------------------------------------------- konfigurasi

const API = { health: 'api/health', ocr: 'api/ocr' };
const THUMB_SIZE = 112;
const CONF_OK = 80;
const CONF_WARN = 60;
const SETTINGS_KEY = 'ocr-angka-massal:settings:v2';
const RESULTS_KEY = 'ocr-angka-massal:hasil:v1';
const VALUE_SEPARATOR = ' ; ';

const defaultSettings = {
  mode: 'card', // 'card' = nomor kartu, 'any' = semua angka
  length: 16,
  luhn: true,
  concurrency: 2,
  perNumber: false,
  delimiter: ';',
};

class ServerDownError extends Error {}

// ---------------------------------------------------------------------- state

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  folderInput: $('folder-input'),
  pickFiles: $('pick-files'),
  pickFolder: $('pick-folder'),
  scanOpen: $('scan-open'),
  scanCount: $('scan-count'),
  scanDownload: $('scan-download'),
  scanCopy: $('scan-copy'),
  notice: $('notice'),
  toolbar: $('toolbar'),
  summaryText: $('summary-text'),
  overall: $('overall'),
  start: $('start'),
  stop: $('stop'),
  redo: $('redo'),
  clear: $('clear'),
  flushStorage: $('flush-storage'),
  download: $('download'),
  copy: $('copy'),
  empty: $('empty'),
  results: $('results'),
  rowTpl: $('row-tpl'),
  viewer: $('viewer'),
  viewerName: $('viewer-name'),
  viewerImg: $('viewer-img'),
  viewerRaw: $('viewer-raw'),
  optMode: $('opt-mode'),
  optLength: $('opt-length'),
  optLuhn: $('opt-luhn'),
  optWorkers: $('opt-workers'),
  optPerNumber: $('opt-per-number'),
  optDelim: $('opt-delim'),
};

const settings = loadSettings();

const state = {
  items: [],
  keys: new Set(),
  running: false,
  stopRequested: false,
  serverDown: false,
  busyMessage: '',
  runStartedAt: 0,
  runCompleted: 0,
  nextId: 1,
  pasteCount: 0,
  scanCount: 0,
};

// ----------------------------------------------------------------- pengaturan

function clamp(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') ?? {};
  } catch {
    /* penyimpanan diblokir atau isinya rusak: pakai bawaan */
  }
  const merged = { ...defaultSettings, ...saved };
  merged.length = clamp(merged.length, 8, 24, defaultSettings.length);
  merged.concurrency = clamp(merged.concurrency, 1, 4, defaultSettings.concurrency);
  return merged;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* penyimpanan diblokir: abaikan */
  }
}

function syncSettingDeps() {
  const card = settings.mode === 'card';
  els.optLength.disabled = !card;
  els.optLuhn.disabled = !card;
}

function bindSettings() {
  els.optMode.value = settings.mode;
  els.optLength.value = settings.length;
  els.optLuhn.checked = settings.luhn;
  els.optWorkers.value = settings.concurrency;
  els.optPerNumber.checked = settings.perNumber;
  els.optDelim.value = settings.delimiter;
  syncSettingDeps();

  const on = (el, key, read) =>
    el.addEventListener('change', () => {
      settings[key] = read(el);
      if (key === 'length' || key === 'concurrency') el.value = settings[key];
      syncSettingDeps();
      saveSettings();
    });
  on(els.optMode, 'mode', (el) => el.value);
  on(els.optLength, 'length', (el) => clamp(el.value, 8, 24, defaultSettings.length));
  on(els.optLuhn, 'luhn', (el) => el.checked);
  on(els.optWorkers, 'concurrency', (el) => clamp(el.value, 1, 4, defaultSettings.concurrency));
  on(els.optPerNumber, 'perNumber', (el) => el.checked);
  on(els.optDelim, 'delimiter', (el) => el.value);
}

const currentOpts = () => ({ mode: settings.mode, length: settings.length, luhn: settings.luhn });

// ------------------------------------------------------- hasil tersimpan (localStorage)

/**
 * Hanya hasil (bukan file foto, yang tidak bisa disimpan di localStorage) disimpan
 * di sini, supaya nomor yang sudah terbaca tidak hilang kalau halaman di-refresh
 * tak sengaja. Baris yang dipulihkan tidak punya file asli: thumbnail, lihat foto,
 * dan proses ulang tidak tersedia, tapi nomornya tetap bisa diedit dan diekspor.
 */
function loadStoredResults() {
  try {
    const saved = JSON.parse(localStorage.getItem(RESULTS_KEY) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveStoredResults() {
  // rawText/passes tidak disertakan: hanya dipakai di viewer foto, yang nonaktif untuk
  // baris yang dipulihkan (tidak ada file asli) — menyimpannya hanya memboroskan kuota.
  const rows = state.items
    .filter((i) => i.status === 'done' || i.status === 'error')
    .map((i) => ({
      path: i.path, status: i.status, opts: i.opts, found: i.found, values: i.values,
      confidence: i.confidence, edited: i.edited, error: i.error,
    }));
  try {
    localStorage.setItem(RESULTS_KEY, JSON.stringify(rows));
  } catch {
    /* penyimpanan diblokir atau penuh: hasil tetap tampil di halaman, hanya tidak tersimpan */
  }
}

function flushStoredResults() {
  try {
    localStorage.removeItem(RESULTS_KEY);
  } catch {
    /* penyimpanan diblokir: abaikan */
  }
}

// --------------------------------------------------------------------- notice

let noticeTimer = 0;

function showNotice(message, kind = '', autoHideMs = 0) {
  clearTimeout(noticeTimer);
  els.notice.textContent = message;
  els.notice.className = `notice ${kind}`.trim();
  els.notice.hidden = false;
  if (autoHideMs) noticeTimer = setTimeout(hideNotice, autoHideMs);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  els.notice.hidden = true;
}

// -------------------------------------------------------- menambah file ke daftar

/** @param {{file: File, path: string}[]} entries */
function addFiles(entries) {
  let notImage = 0;
  let heic = 0;
  let duplicate = 0;
  const fresh = [];

  for (const entry of entries) {
    const kind = classifyFile(entry.file);
    if (kind === 'skip') { notImage++; continue; }
    if (kind === 'unsupported') { heic++; continue; }
    const key = `${entry.path}|${fileKey(entry.file)}`;
    if (state.keys.has(key)) { duplicate++; continue; }
    state.keys.add(key);
    fresh.push({ ...entry, key });
  }

  fresh.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  const fragment = document.createDocumentFragment();
  for (const entry of fresh) {
    const item = createItem(entry);
    state.items.push(item);
    fragment.append(item.ui.li);
    queueThumbnail(item);
  }
  els.results.append(fragment);

  const skipped = [];
  if (heic) skipped.push(`${heic} file HEIC/HEIF/AVIF (belum didukung — ekspor dulu ke JPG)`);
  if (notImage) skipped.push(`${notImage} file bukan gambar`);
  if (duplicate) skipped.push(`${duplicate} file ganda`);
  if (skipped.length) showNotice(`Dilewati: ${skipped.join(', ')}.`);
  else if (fresh.length) hideNotice();

  updateSummary();
}

function createItem({ file, path, key, restored = false }) {
  const li = els.rowTpl.content.firstElementChild.cloneNode(true);
  const ui = {
    li,
    thumbBtn: li.querySelector('.thumb'),
    img: li.querySelector('.thumb img'),
    ph: li.querySelector('.thumb-ph'),
    name: li.querySelector('.name'),
    status: li.querySelector('.status'),
    size: li.querySelector('.size'),
    numbers: li.querySelector('.numbers'),
    note: li.querySelector('.note'),
    badge: li.querySelector('.badge'),
    retry: li.querySelector('.retry'),
    remove: li.querySelector('.remove'),
  };
  const item = {
    id: state.nextId++,
    key,
    file,
    path,
    restored, // true = dipulihkan dari localStorage; tidak ada file asli (lihat foto/proses ulang nonaktif)
    status: 'queued', // queued | processing | done | error
    opts: currentOpts(), // pengaturan saat foto ini diproses (dipakai untuk validasi)
    found: [], // hasil server: [{value, digits, confidence, luhn, length_ok, note}]
    values: [], // yang ditampilkan/diekspor (bisa diedit)
    confidence: null,
    edited: false,
    rawText: '',
    passes: [],
    error: '',
    ui,
  };

  ui.name.textContent = path;
  ui.name.title = path;
  ui.size.textContent = restored ? 'tersimpan' : formatBytes(file.size);

  ui.thumbBtn.addEventListener('click', () => { if (!item.restored) openViewer(item); });
  if (restored) {
    ui.thumbBtn.disabled = true;
    ui.thumbBtn.title = 'Foto asli tidak tersimpan setelah refresh';
  }
  ui.retry.addEventListener('click', () => {
    if (item.restored) return;
    resetItem(item);
    updateRow(item);
    start();
  });
  ui.remove.addEventListener('click', () => removeItem(item));
  ui.numbers.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.numbers.blur(); });
  ui.numbers.addEventListener('change', () => {
    let values = parseManualNumbers(ui.numbers.value);
    if (item.opts.mode === 'card') values = values.map(normalizeCardValue);
    item.values = values;
    item.edited = true;
    ui.numbers.value = values.join(VALUE_SEPARATOR);
    updateRow(item);
    updateSummary();
  });

  updateRow(item);
  return item;
}

function resetItem(item) {
  Object.assign(item, {
    status: 'queued', found: [], values: [], confidence: null,
    edited: false, rawText: '', passes: [], error: '',
  });
}

function removeItem(item) {
  if (item.status === 'processing') return;
  state.items = state.items.filter((i) => i !== item);
  state.keys.delete(item.key);
  item.ui.li.remove();
  updateSummary();
}

// ------------------------------------------------------------------- render UI

const STATUS_TEXT = { queued: 'Menunggu', processing: 'Memproses…', done: 'Selesai', error: 'Gagal' };

function confidenceClass(c) {
  if (c >= CONF_OK) return 'ok';
  if (c >= CONF_WARN) return 'warn';
  return 'bad';
}

/** Badge + catatan untuk satu baris, dihitung dari nilai yang sedang tampil (termasuk hasil edit). */
function assess(item) {
  const out = { badge: '', badgeClass: '', title: '', note: '', noteBad: false, valid: false, needsCheck: false };
  if (item.status === 'error') {
    return { ...out, note: item.error, noteBad: true, badge: 'Gagal', badgeClass: 'bad', needsCheck: true };
  }
  if (item.status !== 'done') return out;
  if (!item.values.length) {
    out.note = item.opts.mode === 'card' ? 'Nomor kartu tidak ditemukan' : 'Tidak ada angka terbaca';
    out.needsCheck = item.opts.mode === 'card';
    return out;
  }

  const confText = item.confidence == null ? '' : ` · keyakinan OCR ${Math.round(item.confidence)}%`;
  if (item.opts.mode === 'card') {
    const problems = new Set();
    for (const value of item.values) {
      const s = cardStatus(value, item.opts);
      if (!s.lengthOk) problems.add(`${s.digits.length} digit (seharusnya ${item.opts.length})`);
      else if (s.luhn === false) problems.add('checksum Luhn tidak cocok');
    }
    if (problems.size) {
      return { ...out, badge: 'Periksa', badgeClass: 'warn', needsCheck: true, noteBad: true,
        note: `Periksa: ${[...problems].join('; ')}`, title: 'Nomor ini kemungkinan ada digit yang salah baca' };
    }
    if (item.opts.luhn) {
      return { ...out, badge: 'Valid', badgeClass: 'ok', valid: true,
        title: `Panjang pas dan checksum Luhn cocok${item.edited ? '' : confText}`,
        note: item.edited ? 'Diedit manual' : '' };
    }
  }

  if (item.edited) return { ...out, badge: 'Diedit', note: 'Diedit manual' };
  const shaky = item.found.filter((n) => n.confidence < CONF_WARN).map((n) => n.value);
  return {
    ...out,
    badge: `${Math.round(item.confidence)}%`,
    badgeClass: confidenceClass(item.confidence),
    title: `Keyakinan terendah di antara angka pada foto ini`,
    note: shaky.length ? `Periksa: ${shaky.join(', ')}` : '',
    noteBad: shaky.length > 0,
    needsCheck: shaky.length > 0,
  };
}

function updateRow(item) {
  const { ui } = item;
  ui.li.dataset.status = item.status;
  ui.status.textContent = STATUS_TEXT[item.status];

  ui.numbers.disabled = item.status !== 'done';
  if (document.activeElement !== ui.numbers) ui.numbers.value = item.values.join(VALUE_SEPARATOR);

  ui.retry.disabled = item.status === 'processing' || item.restored;
  ui.remove.disabled = item.status === 'processing';
  ui.retry.hidden = item.status === 'queued' || item.restored;

  const a = assess(item);
  ui.note.textContent = a.note;
  ui.note.classList.toggle('bad', a.noteBad);
  ui.badge.textContent = a.badge;
  ui.badge.className = `badge ${a.badgeClass}`.trim();
  ui.badge.title = a.title;
}

// Thumbnail dibuat satu per satu agar ratusan foto besar tidak didekode serentak (lonjakan memori).
let thumbChain = Promise.resolve();

function queueThumbnail(item) {
  thumbChain = thumbChain
    .then(() => (state.keys.has(item.key) ? makeThumbnail(item.file) : null))
    .then((url) => setThumbnail(item, url))
    .catch(() => {}); // foto rusak: biarkan placeholder; servernya yang melaporkan error
}

function setThumbnail(item, url) {
  if (!url) return;
  item.ui.img.src = url;
  item.ui.img.hidden = false;
  item.ui.ph.setAttribute('hidden', ''); // SVG tidak punya properti .hidden
}

function counts() {
  const c = { queued: 0, processing: 0, done: 0, error: 0 };
  for (const item of state.items) c[item.status]++;
  return c;
}

function updateSummary() {
  saveStoredResults();
  const total = state.items.length;
  const c = counts();
  const finished = c.done + c.error;

  els.toolbar.hidden = total === 0;
  els.empty.hidden = total > 0;

  const parts = [`${finished} dari ${total} foto selesai`];
  if (c.error) parts.push(`${c.error} gagal`);
  let text = parts.join(' · ');
  if (state.running) {
    let extra = state.stopRequested ? 'menghentikan…' : state.busyMessage;
    if (!extra && state.runCompleted >= 2) {
      const perItem = (performance.now() - state.runStartedAt) / state.runCompleted;
      extra = `perkiraan sisa ${formatDuration(perItem * (c.queued + c.processing))}`;
    }
    if (extra) text += ` · ${extra}`;
  }
  els.summaryText.textContent = text;
  els.overall.value = total ? finished / total : 0;

  const pending = c.queued + c.error;
  els.start.hidden = state.running;
  els.start.disabled = pending === 0;
  els.start.textContent = pending ? `Mulai OCR (${pending})` : 'Mulai OCR';
  els.stop.hidden = !state.running;
  els.stop.disabled = state.stopRequested;
  els.redo.disabled = state.running || c.done === 0;
  els.clear.disabled = state.running;
  els.download.disabled = c.done === 0;
  els.copy.disabled = c.done === 0;

  // Salinan kontrol ekspor di dalam dialog scan (dialog modal menutupi toolbar utama).
  els.scanCount.textContent = c.done ? `${c.done} hasil tersimpan di daftar` : 'Belum ada hasil';
  els.scanDownload.disabled = c.done === 0;
  els.scanCopy.disabled = c.done === 0;
}

// ------------------------------------------------------------------ thumbnail

async function makeThumbnail(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, THUMB_SIZE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.7);
  } finally {
    bitmap.close?.();
  }
}

// ----------------------------------------------------------------- server OCR

const errorMessage = (err) => String(err?.message ?? err ?? 'Kesalahan tidak diketahui');

async function checkServer() {
  try {
    const res = await fetch(API.health, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

function serverDownMessage() {
  return location.protocol === 'file:'
    ? 'Halaman dibuka langsung dari file. Jalankan "python server.py" lalu buka http://localhost:8080.'
    : 'Server OCR tidak terjangkau. Pastikan "python server.py" masih berjalan, lalu coba lagi.';
}

/** Kirim satu gambar ke server OCR. `passes` membatasi percobaan variasi (frame webcam = 1). */
async function postOcr(file, opts, { passes } = {}) {
  const form = new FormData();
  form.append('file', file, file.name || 'frame.jpg');
  form.append('mode', opts.mode);
  form.append('length', String(opts.length));
  form.append('luhn', opts.luhn ? '1' : '0');
  if (passes) form.append('passes', String(passes));

  let res;
  try {
    res = await fetch(API.ocr, { method: 'POST', body: form });
  } catch {
    throw new ServerDownError(serverDownMessage());
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server OCR menjawab ${res.status}`);
  }
  return res.json();
}

function applyResult(item, data, numbers = data.numbers ?? []) {
  item.found = numbers;
  item.values = numbers.map((n) => n.value);
  item.confidence = lowestConfidence(numbers.map((n) => n.confidence));
  item.rawText = data.raw_text ?? '';
  item.passes = data.passes ?? [];
  item.status = 'done';
}

async function processItem(item) {
  item.opts = currentOpts();
  try {
    applyResult(item, await postOcr(item.file, item.opts));
  } catch (err) {
    if (err instanceof ServerDownError) {
      // Bukan salah fotonya: kembalikan ke antrean dan hentikan semua proses.
      resetItem(item);
      state.serverDown = true;
      state.stopRequested = true;
    } else {
      item.status = 'error';
      item.error = errorMessage(err);
    }
  } finally {
    if (item.status === 'done' || item.status === 'error') state.runCompleted++;
    updateRow(item);
    updateSummary();
  }
}

async function workerLoop() {
  while (!state.stopRequested) {
    const item = state.items.find((i) => i.status === 'queued');
    if (!item) return;
    item.status = 'processing'; // klaim sebelum await agar tidak diambil loop lain
    updateRow(item);
    await processItem(item);
  }
}

async function start() {
  if (state.running) return;
  for (const item of state.items) if (item.status === 'error') { resetItem(item); updateRow(item); }
  if (!state.items.some((i) => i.status === 'queued')) { updateSummary(); return; }

  state.running = true;
  state.stopRequested = false;
  state.serverDown = false;
  state.runStartedAt = performance.now();
  state.runCompleted = 0;
  hideNotice();

  state.busyMessage = 'menghubungi server OCR…';
  updateSummary();
  if (await checkServer()) {
    state.busyMessage = '';
    updateSummary();
    await Promise.all(Array.from({ length: settings.concurrency }, workerLoop));
  } else {
    state.serverDown = true;
  }

  state.running = false;
  state.busyMessage = '';
  updateSummary();

  if (state.serverDown) showNotice(serverDownMessage(), 'error');
  else if (!state.stopRequested && state.items.some((i) => i.status === 'queued')) start(); // diantrikan ulang saat berjalan
  else if (!state.stopRequested && state.items.length) announceDone();
}

function announceDone() {
  const c = counts();
  const rows = state.items.filter((i) => i.status === 'done').map(assess);
  const bits = [`Selesai: ${c.done} foto dibaca`];
  if (settings.mode === 'card' && settings.luhn) bits.push(`${rows.filter((r) => r.valid).length} nomor valid`);
  if (c.error) bits.push(`${c.error} gagal`);
  const check = rows.filter((r) => r.needsCheck).length;
  if (check) bits.push(`${check} perlu diperiksa`);
  showNotice(`${bits.join(', ')}.`, c.error || check ? '' : 'info');
}

function stop() {
  if (!state.running) return;
  state.stopRequested = true;
  updateSummary();
}

// ----------------------------------------------------------------------- ekspor

function exportRows() {
  const done = state.items.filter((i) => i.status === 'done');
  const items = done.map((i) => ({
    name: i.path,
    numbers: i.values.map((value) => ({ value, luhn: cardStatus(value, i.opts).luhn })),
    confidence: i.edited ? null : i.confidence,
  }));
  return buildExportRows(items, { perNumber: settings.perNumber, card: done.every((i) => i.opts.mode === 'card') });
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadCSV() {
  const csv = toCSV(exportRows(), settings.delimiter);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `hasil-ocr-${timestamp()}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `report(pesan, jenis)`: tempat menampilkan hasil; default notifikasi halaman (tidak terlihat di balik dialog modal). */
async function copyTSV(report = (message, kind) => showNotice(message, kind === 'ok' ? 'info' : kind, 4000)) {
  const rows = exportRows();
  const text = toTSV(rows);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    // Di dalam dialog modal, elemen di luar dialog bersifat inert sehingga tidak bisa dipilih.
    (document.querySelector('dialog[open]') ?? document.body).append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) { report('Gagal menyalin ke clipboard. Gunakan tombol Unduh CSV.', 'error'); return; }
  }
  report(`${rows.length - 1} baris disalin. Tempel langsung di Excel atau Google Sheets.`, 'ok');
}

// ----------------------------------------------------------------------- viewer

let viewerUrl = '';

function openViewer(item) {
  viewerUrl = URL.createObjectURL(item.file);
  els.viewerName.textContent = item.path;
  els.viewerImg.src = viewerUrl;
  const raw = item.rawText.trim() || (item.status === 'done' ? '(kosong)' : '(belum diproses)');
  const tried = item.passes.length > 1 ? `Percobaan: ${item.passes.join(' → ')}\n\n` : '';
  els.viewerRaw.textContent = tried + raw;
  els.viewer.showModal();
}

els.viewer.addEventListener('close', () => {
  els.viewerImg.removeAttribute('src');
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = '';
});
els.viewer.addEventListener('click', (e) => { if (e.target === els.viewer) els.viewer.close(); });

// -------------------------------------------------- input file, drag & drop, paste

const fromPicker = (fileList) => [...fileList].map((file) => ({ file, path: file.webkitRelativePath || file.name }));

async function walkEntry(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, path: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) await walkEntry(child, out);
    } while (batch.length);
  }
}

async function filesFromDrop(dataTransfer) {
  // Entri harus diambil sinkron sebelum await pertama (DataTransfer dikosongkan setelah event).
  const entries = [...(dataTransfer.items ?? [])]
    .map((it) => (it.kind === 'file' ? it.webkitGetAsEntry?.() : null))
    .filter(Boolean);
  if (!entries.length) return fromPicker(dataTransfer.files);
  const out = [];
  for (const entry of entries) await walkEntry(entry, out);
  return out;
}

function bindInputs() {
  els.pickFiles.addEventListener('click', () => els.fileInput.click());
  els.pickFolder.addEventListener('click', () => els.folderInput.click());
  for (const input of [els.fileInput, els.folderInput]) {
    input.addEventListener('change', () => {
      addFiles(fromPicker(input.files));
      input.value = '';
    });
  }

  let depth = 0;
  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    els.dropzone.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) els.dropzone.classList.remove('dragging');
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    els.dropzone.classList.remove('dragging');
    try {
      addFiles(await filesFromDrop(e.dataTransfer));
    } catch (err) {
      showNotice(`Gagal membaca file yang dilepas: ${errorMessage(err)}`, 'error');
    }
  });

  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return; // tempel teks ke kolom nomor tetap normal
    e.preventDefault();
    addFiles(files.map((file) => {
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      return { file, path: `tempel-${++state.pasteCount}.${ext}` };
    }));
  });
}

// ------------------------------------------------------------------------ init

function bindActions() {
  els.start.addEventListener('click', start);
  els.stop.addEventListener('click', stop);
  els.download.addEventListener('click', downloadCSV);
  els.copy.addEventListener('click', () => copyTSV());

  els.redo.addEventListener('click', () => {
    if (state.items.some((i) => i.edited) && !confirm('Nomor yang sudah Anda edit manual akan tertimpa. Lanjutkan?')) return;
    for (const item of state.items) if (item.status !== 'processing') { resetItem(item); updateRow(item); }
    start();
  });

  els.clear.addEventListener('click', () => {
    if (!state.items.length || !confirm(`Hapus ${state.items.length} foto beserta hasilnya dari daftar?`)) return;
    state.items = [];
    state.keys.clear();
    els.results.replaceChildren();
    hideNotice();
    updateSummary();
  });

  els.flushStorage.addEventListener('click', () => {
    if (!confirm('Hapus semua hasil OCR yang tersimpan di penyimpanan lokal browser ini? Daftar yang sedang tampil juga akan dikosongkan.')) return;
    state.items = [];
    state.keys.clear();
    els.results.replaceChildren();
    flushStoredResults();
    hideNotice();
    updateSummary();
    showNotice('Data tersimpan sudah dihapus.', 'info', 4000);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.items.some((i) => i.status === 'done')) e.preventDefault();
  });
}

/** Munculkan kembali hasil OCR dari sesi sebelumnya (tanpa file foto, lihat batasan di saveStoredResults). */
function restoreStoredResults() {
  const saved = loadStoredResults();
  if (!saved.length) return;

  const fragment = document.createDocumentFragment();
  for (const row of saved) {
    const key = `restored|${row.path}|${state.nextId}`;
    const item = createItem({ file: null, path: row.path, key, restored: true });
    state.keys.add(key);
    Object.assign(item, {
      status: row.status, opts: row.opts, found: row.found, values: row.values,
      confidence: row.confidence, edited: row.edited, error: row.error,
    });
    state.items.push(item);
    fragment.append(item.ui.li);
    updateRow(item);
  }
  els.results.append(fragment);
  showNotice(`${saved.length} hasil dipulihkan dari sesi sebelumnya (foto asli tidak tersimpan).`, 'info', 6000);
  updateSummary();
}

// ------------------------------------------------------------------ scan webcam

const digitsOf = (value) => value.replace(/\D/g, '');

function webcamFile(blob) {
  return new File([blob], `webcam-${String(++state.scanCount).padStart(3, '0')}.jpg`,
    { type: 'image/jpeg', lastModified: Date.now() });
}

/** Nomor yang sudah terkonfirmasi di pemindai langsung masuk daftar sebagai hasil jadi (tanpa OCR ulang). */
function addScannedItem(blob, data, number) {
  const file = webcamFile(blob);
  const item = createItem({ file, path: file.name, key: `${file.name}|${file.size}|${file.lastModified}` });
  state.keys.add(item.key);
  state.items.push(item);
  els.results.append(item.ui.li);
  item.opts = currentOpts();
  applyResult(item, data, [number]);
  updateRow(item);
  queueThumbnail(item);
  hideNotice();
  updateSummary();
}

const scanner = createScanner({
  ui: {
    dialog: $('scanner'),
    video: $('scan-video'),
    status: $('scan-status'),
    flash: $('scan-flash'),
    auto: $('scan-auto'),
    camera: $('scan-camera'),
    snap: $('scan-snap'),
    done: $('scan-done'),
    close: $('scan-close'),
    found: $('scan-found'),
  },
  recognizeFrame: (blob) => postOcr(blob, currentOpts(), { passes: 1 }), // cepat: frame berikutnya = kesempatan baru
  onConfirmed: addScannedItem,
  onSnap: (blob) => {
    const file = webcamFile(blob);
    addFiles([{ file, path: file.name }]);
    start(); // foto manual diproses seperti unggahan biasa (semua percobaan variasi)
  },
  isDuplicate: (digits) => state.items.some((i) => i.values.some((v) => digitsOf(v) === digits)),
  autoAllowed: () => settings.mode === 'card',
});
els.scanOpen.addEventListener('click', () => scanner.open());
els.scanDownload.addEventListener('click', () => {
  downloadCSV();
  scanner.say('CSV diunduh.', 'ok');
});
els.scanCopy.addEventListener('click', () => copyTSV((message, kind) => scanner.say(message, kind)));

bindSettings();
bindInputs();
bindActions();
restoreStoredResults();
updateSummary();
checkServer().then((ok) => { if (!ok) showNotice(serverDownMessage(), 'error'); });
