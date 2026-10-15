import {
  buildExportRows,
  classifyFile,
  extractFromPage,
  fileKey,
  fitSize,
  formatBytes,
  formatDuration,
  lowestConfidence,
  parseManualNumbers,
  preprocessPixels,
  toCSV,
  toTSV,
} from './lib.js';

// ---------------------------------------------------------------- konfigurasi

/** Semua aset OCR disajikan dari repo ini (tanpa CDN) agar bisa dipakai offline. */
const ASSETS = {
  workerPath: 'vendor/tesseract/worker.min.js',
  corePath: 'vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  langPath: 'vendor/tessdata',
};
const DIGIT_WHITELIST = '0123456789.,-';
const THUMB_SIZE = 112;
const CONF_OK = 80;
const CONF_WARN = 60;
const SETTINGS_KEY = 'ocr-angka-massal:settings:v1';

const defaultSettings = {
  digitsOnly: false,
  psm: '3',
  preprocess: 'auto',
  concurrency: Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 1)),
  perNumber: false,
  delimiter: ';',
};

// ---------------------------------------------------------------------- state

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  folderInput: $('folder-input'),
  pickFiles: $('pick-files'),
  pickFolder: $('pick-folder'),
  notice: $('notice'),
  toolbar: $('toolbar'),
  summaryText: $('summary-text'),
  overall: $('overall'),
  start: $('start'),
  stop: $('stop'),
  redo: $('redo'),
  clear: $('clear'),
  download: $('download'),
  copy: $('copy'),
  empty: $('empty'),
  results: $('results'),
  rowTpl: $('row-tpl'),
  viewer: $('viewer'),
  viewerName: $('viewer-name'),
  viewerImg: $('viewer-img'),
  viewerRaw: $('viewer-raw'),
  optDigits: $('opt-digits'),
  optPsm: $('opt-psm'),
  optPre: $('opt-pre'),
  optWorkers: $('opt-workers'),
  optPerNumber: $('opt-per-number'),
  optDelim: $('opt-delim'),
};

const settings = loadSettings();

const state = {
  items: [],
  keys: new Set(),
  slots: [], // worker OCR yang sedang hidup
  running: false,
  stopRequested: false,
  busyMessage: '',
  runStartedAt: 0,
  runCompleted: 0,
  nextId: 1,
  pasteCount: 0,
};

// ----------------------------------------------------------------- pengaturan

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { ...defaultSettings, ...saved };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* penyimpanan diblokir: abaikan */
  }
}

function clampWorkers(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : defaultSettings.concurrency;
}

function bindSettings() {
  els.optDigits.checked = settings.digitsOnly;
  els.optPsm.value = settings.psm;
  els.optPre.value = settings.preprocess;
  els.optWorkers.value = clampWorkers(settings.concurrency);
  els.optPerNumber.checked = settings.perNumber;
  els.optDelim.value = settings.delimiter;

  const on = (el, key, read) =>
    el.addEventListener('change', () => {
      settings[key] = read(el);
      if (key === 'concurrency') el.value = settings[key];
      saveSettings();
    });
  on(els.optDigits, 'digitsOnly', (el) => el.checked);
  on(els.optPsm, 'psm', (el) => el.value);
  on(els.optPre, 'preprocess', (el) => el.value);
  on(els.optWorkers, 'concurrency', (el) => clampWorkers(el.value));
  on(els.optPerNumber, 'perNumber', (el) => el.checked);
  on(els.optDelim, 'delimiter', (el) => el.value);
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
  }
  els.results.append(fragment);

  const skipped = [];
  if (heic) skipped.push(`${heic} file HEIC/HEIF (belum didukung browser — konversi ke JPG dulu)`);
  if (notImage) skipped.push(`${notImage} file bukan gambar`);
  if (duplicate) skipped.push(`${duplicate} file ganda`);
  if (skipped.length) showNotice(`Dilewati: ${skipped.join(', ')}.`);
  else if (fresh.length) hideNotice();

  updateSummary();
}

function createItem({ file, path, key }) {
  const li = els.rowTpl.content.firstElementChild.cloneNode(true);
  const ui = {
    li,
    thumbBtn: li.querySelector('.thumb'),
    img: li.querySelector('.thumb img'),
    ph: li.querySelector('.thumb-ph'),
    name: li.querySelector('.name'),
    status: li.querySelector('.status'),
    size: li.querySelector('.size'),
    bar: li.querySelector('.row-bar'),
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
    status: 'queued', // queued | processing | done | error
    progress: 0,
    found: [], // [{value, confidence}] hasil OCR
    values: [], // daftar angka yang ditampilkan/diekspor (bisa diedit)
    confidence: null,
    edited: false,
    rawText: '',
    error: '',
    ui,
  };

  ui.name.textContent = path;
  ui.name.title = path;
  ui.size.textContent = formatBytes(file.size);

  ui.thumbBtn.addEventListener('click', () => openViewer(item));
  ui.retry.addEventListener('click', () => {
    resetItem(item);
    updateRow(item);
    start();
  });
  ui.remove.addEventListener('click', () => removeItem(item));
  ui.numbers.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.numbers.blur(); });
  ui.numbers.addEventListener('change', () => {
    item.values = parseManualNumbers(ui.numbers.value);
    item.edited = true;
    updateRow(item);
    updateSummary();
  });

  updateRow(item);
  return item;
}

function resetItem(item) {
  Object.assign(item, {
    status: 'queued', progress: 0, found: [], values: [],
    confidence: null, edited: false, rawText: '', error: '',
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

const STATUS_TEXT = { queued: 'Menunggu', done: 'Selesai', error: 'Gagal' };

function confidenceClass(c) {
  if (c >= CONF_OK) return 'ok';
  if (c >= CONF_WARN) return 'warn';
  return 'bad';
}

function updateProgress(item) {
  const { ui } = item;
  ui.bar.value = item.progress;
  ui.status.textContent = `Memproses ${Math.round(item.progress * 100)}%`;
}

function updateRow(item) {
  const { ui } = item;
  ui.li.dataset.status = item.status;

  if (item.status === 'processing') updateProgress(item);
  else ui.status.textContent = STATUS_TEXT[item.status];

  const editable = item.status === 'done';
  ui.numbers.disabled = !editable;
  if (document.activeElement !== ui.numbers) ui.numbers.value = item.values.join(' ');

  ui.retry.disabled = item.status === 'processing';
  ui.remove.disabled = item.status === 'processing';
  ui.retry.hidden = item.status === 'queued';

  let note = '';
  let noteBad = false;
  let badge = '';
  let badgeClass = '';
  if (item.status === 'error') {
    note = item.error;
    noteBad = true;
    badge = 'Gagal';
    badgeClass = 'bad';
  } else if (item.status === 'done') {
    if (item.edited) {
      note = 'Diedit manual';
      badge = 'Diedit';
    } else if (!item.values.length) {
      note = 'Tidak ada angka terbaca';
    } else {
      badge = `${Math.round(item.confidence)}%`;
      badgeClass = confidenceClass(item.confidence);
      const shaky = item.found.filter((n) => n.confidence < CONF_WARN).map((n) => n.value);
      if (shaky.length) { note = `Periksa: ${shaky.join(', ')}`; noteBad = true; }
    }
  }
  ui.note.textContent = note;
  ui.note.classList.toggle('bad', noteBad);
  ui.badge.textContent = badge;
  ui.badge.className = `badge ${badgeClass}`.trim();
  ui.badge.title = badge && !item.edited ? 'Keyakinan terendah di antara angka pada foto ini' : '';
}

function counts() {
  const c = { queued: 0, processing: 0, done: 0, error: 0 };
  for (const item of state.items) c[item.status]++;
  return c;
}

function updateSummary() {
  const total = state.items.length;
  const c = counts();
  const finished = c.done + c.error;

  els.toolbar.hidden = total === 0;
  els.empty.hidden = total > 0;

  const parts = [`${finished} dari ${total} foto selesai`];
  if (c.error) parts.push(`${c.error} gagal`);
  let html = parts.join(' · ');
  if (state.running) {
    let extra = state.stopRequested ? 'menghentikan…' : state.busyMessage;
    if (!extra && state.runCompleted >= 2) {
      const perItem = (performance.now() - state.runStartedAt) / state.runCompleted;
      extra = `perkiraan sisa ${formatDuration(perItem * (c.queued + c.processing))}`;
    }
    if (extra) html += ` · ${extra}`;
  }
  els.summaryText.textContent = html;
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
}

// -------------------------------------------------------------- pra-proses gambar

async function decodeImage(file) {
  try {
    return await createImageBitmap(file); // EXIF orientation diterapkan otomatis
  } catch {
    throw new Error('Gambar rusak atau formatnya tidak didukung browser');
  }
}

function makeThumbnail(bitmap) {
  const scale = THUMB_SIZE / Math.max(bitmap.width, bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * Math.min(1, scale)));
  const h = Math.max(1, Math.round(bitmap.height * Math.min(1, scale)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.7);
}

/** Ubah foto menjadi PNG siap-OCR (diskalakan + diperbaiki kontrasnya). */
async function prepareImage(file, mode) {
  const bitmap = await decodeImage(file);
  try {
    const { width, height } = fitSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: mode !== 'none' });
    ctx.fillStyle = '#fff'; // PNG transparan -> latar putih
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (mode !== 'none') {
      const pixels = ctx.getImageData(0, 0, width, height);
      preprocessPixels(pixels.data, mode);
      ctx.putImageData(pixels, 0, 0);
    }
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Gagal menyiapkan gambar'))), 'image/png'));
    return { blob, thumb: makeThumbnail(bitmap) };
  } finally {
    bitmap.close?.();
  }
}

// ------------------------------------------------------------------- mesin OCR

function errorMessage(err) {
  return String(err?.message ?? err ?? 'Kesalahan tidak diketahui');
}

async function spawnWorker(slot) {
  slot.params = '';
  slot.broken = false;
  slot.worker = await Tesseract.createWorker('eng', 1, {
    ...ASSETS,
    logger: (m) => {
      if (m.status === 'recognizing text' && slot.current) {
        slot.current.progress = m.progress;
        updateProgress(slot.current);
      }
    },
  });
}

async function createSlot() {
  const slot = { worker: null, current: null, broken: false, params: '' };
  await spawnWorker(slot);
  return slot;
}

async function recycleWorker(slot) {
  const old = slot.worker;
  slot.worker = null;
  try { await old?.terminate(); } catch { /* sudah mati */ }
  await spawnWorker(slot);
}

async function ensureSlots(count) {
  while (state.slots.length > count) {
    const slot = state.slots.pop();
    slot.worker?.terminate().catch(() => {});
  }
  const missing = count - state.slots.length;
  if (missing <= 0) return;

  const settled = await Promise.allSettled(Array.from({ length: missing }, createSlot));
  for (const r of settled) if (r.status === 'fulfilled') state.slots.push(r.value);
  if (!state.slots.length) throw settled.find((r) => r.status === 'rejected').reason;
  if (state.slots.length < count) {
    showNotice(`Hanya ${state.slots.length} dari ${count} proses paralel yang berhasil dimulai (memori terbatas?).`);
  }
}

async function applyParams(slot) {
  const params = {
    tessedit_pageseg_mode: settings.psm,
    tessedit_char_whitelist: settings.digitsOnly ? DIGIT_WHITELIST : '',
  };
  const signature = JSON.stringify(params);
  if (slot.params === signature) return;
  await slot.worker.setParameters(params);
  slot.params = signature;
}

async function processItem(slot, item) {
  slot.current = item;
  try {
    const { blob, thumb } = await prepareImage(item.file, settings.preprocess);
    item.ui.img.src = thumb;
    item.ui.img.hidden = false;
    item.ui.ph.setAttribute('hidden', ''); // SVG tidak punya properti .hidden

    try {
      await applyParams(slot);
      const { data } = await slot.worker.recognize(blob, {}, { text: true, blocks: true });
      item.rawText = data.text ?? '';
      item.found = extractFromPage(data);
      item.values = item.found.map((n) => n.value);
      item.confidence = lowestConfidence(item.found);
      item.status = 'done';
    } catch (err) {
      slot.broken = true; // wasm bisa crash (mis. kehabisan memori): buat ulang worker
      throw err;
    }
  } catch (err) {
    item.status = 'error';
    item.error = errorMessage(err);
  } finally {
    slot.current = null;
    item.progress = item.status === 'done' ? 1 : 0;
    state.runCompleted++;
    updateRow(item);
    updateSummary();
  }
}

async function workerLoop(slot) {
  while (!state.stopRequested) {
    const item = state.items.find((i) => i.status === 'queued');
    if (!item) return;
    item.status = 'processing'; // klaim sebelum await agar tidak diambil worker lain
    item.progress = 0;
    updateRow(item);
    try {
      if (slot.broken) await recycleWorker(slot);
    } catch (err) {
      resetItem(item);
      updateRow(item);
      throw err;
    }
    await processItem(slot, item);
  }
}

async function start() {
  if (state.running) return;
  if (typeof Tesseract === 'undefined') {
    showNotice('Pustaka OCR gagal dimuat (vendor/tesseract/tesseract.min.js). Muat ulang halaman.', 'error');
    return;
  }
  for (const item of state.items) if (item.status === 'error') { resetItem(item); updateRow(item); }
  if (!state.items.some((i) => i.status === 'queued')) { updateSummary(); return; }

  state.running = true;
  state.stopRequested = false;
  state.runStartedAt = performance.now();
  state.runCompleted = 0;
  let fatal = false;
  hideNotice();

  try {
    state.busyMessage = 'memuat mesin OCR…';
    updateSummary();
    await ensureSlots(clampWorkers(settings.concurrency));
    state.busyMessage = '';
    updateSummary();

    const results = await Promise.allSettled(state.slots.map(workerLoop));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) {
      fatal = true;
      showNotice(`Salah satu proses OCR berhenti: ${errorMessage(failed.reason)}`, 'error');
    }
  } catch (err) {
    fatal = true;
    showNotice(
      `Mesin OCR gagal dimuat: ${errorMessage(err)}. Buka lewat server (npm start), bukan langsung dari file, ` +
      'dan pakai browser versi terbaru.',
      'error',
    );
  } finally {
    state.running = false;
    state.busyMessage = '';
    for (const item of state.items) {
      if (item.status === 'processing') { resetItem(item); updateRow(item); }
    }
    updateSummary();
  }

  // Foto yang diantrikan ulang saat proses hampir selesai.
  if (!fatal && !state.stopRequested && state.items.some((i) => i.status === 'queued')) start();
  else if (!fatal && !state.stopRequested && state.items.length) announceDone();
}

function announceDone() {
  const c = counts();
  const low = state.items.filter((i) => i.status === 'done' && !i.edited && i.values.length && i.confidence < CONF_WARN).length;
  const empty = state.items.filter((i) => i.status === 'done' && !i.values.length).length;
  const bits = [`Selesai: ${c.done} foto dibaca`];
  if (c.error) bits.push(`${c.error} gagal`);
  if (empty) bits.push(`${empty} tanpa angka`);
  if (low) bits.push(`${low} perlu diperiksa`);
  showNotice(`${bits.join(', ')}.`, c.error || low || empty ? '' : 'info');
}

function stop() {
  if (!state.running) return;
  state.stopRequested = true;
  updateSummary();
}

// ----------------------------------------------------------------------- ekspor

function exportRows() {
  const items = state.items
    .filter((i) => i.status === 'done')
    .map((i) => ({ name: i.path, numbers: i.values, confidence: i.edited ? null : i.confidence }));
  return buildExportRows(items, { perNumber: settings.perNumber });
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

async function copyTSV() {
  const rows = exportRows();
  const text = toTSV(rows);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) { showNotice('Gagal menyalin ke clipboard. Gunakan tombol Unduh CSV.', 'error'); return; }
  }
  showNotice(`${rows.length - 1} baris disalin. Tempel langsung di Excel atau Google Sheets.`, 'info', 4000);
}

// ----------------------------------------------------------------------- viewer

let viewerUrl = '';

function openViewer(item) {
  viewerUrl = URL.createObjectURL(item.file);
  els.viewerName.textContent = item.path;
  els.viewerImg.src = viewerUrl;
  els.viewerRaw.textContent = item.rawText.trim() || (item.status === 'done' ? '(kosong)' : '(belum diproses)');
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
    if (!files.length) return; // tempel teks ke kolom angka tetap normal
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
  els.copy.addEventListener('click', copyTSV);

  els.redo.addEventListener('click', () => {
    if (state.items.some((i) => i.edited) && !confirm('Angka yang sudah Anda edit manual akan tertimpa. Lanjutkan?')) return;
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

  window.addEventListener('beforeunload', (e) => {
    if (state.items.some((i) => i.status === 'done')) e.preventDefault();
  });
}

bindSettings();
bindInputs();
bindActions();
updateSummary();

if (location.protocol === 'file:') {
  showNotice('Halaman ini dibuka langsung dari file sehingga mesin OCR tidak bisa berjalan. Jalankan "npm start" lalu buka http://localhost:8080.', 'error');
}
