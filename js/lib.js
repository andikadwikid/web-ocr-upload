// Fungsi murni (tanpa DOM) supaya bisa dipakai di browser dan diuji di Node.

/**
 * Pola angka: bilangan bulat/desimal, boleh diawali "-" dan boleh memakai
 * pemisah ribuan/desimal "." atau ",". Tanda "-" hanya dianggap negatif bila
 * tidak menempel pada angka sebelumnya (jadi "0812-3456" -> "0812", "3456").
 */
const NUMBER_RE = /(?<![\d.,])-?\d+(?:[.,]\d+)*/g;

/** Ambil semua angka dari sebuah teks. */
export function extractNumbers(text) {
  if (!text) return [];
  return text.match(NUMBER_RE) ?? [];
}

/**
 * Ambil angka beserta tingkat keyakinan (0-100) dari hasil Tesseract.
 * Memakai kata (word) bila tersedia supaya tiap angka punya confidence sendiri;
 * kalau tidak, jatuh kembali ke teks utuh dengan confidence halaman.
 */
export function extractFromPage(page) {
  const found = [];
  const words = [];
  for (const block of page?.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) words.push(word);
      }
    }
  }
  if (words.length) {
    for (const word of words) {
      for (const value of extractNumbers(word.text)) {
        found.push({ value, confidence: clampConfidence(word.confidence) });
      }
    }
  } else {
    const confidence = clampConfidence(page?.confidence);
    for (const value of extractNumbers(page?.text)) found.push({ value, confidence });
  }
  return found;
}

function clampConfidence(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/**
 * Confidence terendah dari daftar angka; null bila kosong. Dipakai (bukan rata-rata)
 * karena satu angka yang salah sudah merusak data, jadi baris itu harus ditandai.
 */
export function lowestConfidence(numbers) {
  if (!numbers.length) return null;
  return Math.min(...numbers.map((n) => n.confidence));
}

/** Pecah isian manual pengguna menjadi daftar angka (dipisah spasi/titik koma). */
export function parseManualNumbers(input) {
  return input
    .split(/[\s;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- Ekspor ----------

/** Cegah "CSV injection": sel yang diawali = + - @ dibaca Excel sebagai rumus. */
function neutralizeFormula(value) {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function csvCell(value, delimiter = ',') {
  const s = String(value ?? '');
  return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Susun baris ekspor dari daftar hasil.
 * @param {{name:string, numbers:string[], confidence:number|null}[]} items
 * @param {{perNumber:boolean}} opts  true = satu baris per angka
 */
export function buildExportRows(items, { perNumber = false } = {}) {
  const confText = (c) => (c == null ? '' : String(Math.round(c)));
  if (perNumber) {
    const rows = [['nama_file', 'urutan', 'angka', 'keyakinan_persen']];
    for (const it of items) {
      if (!it.numbers.length) rows.push([it.name, '', '', confText(it.confidence)]);
      it.numbers.forEach((n, i) => rows.push([it.name, String(i + 1), n, confText(it.confidence)]));
    }
    return rows;
  }
  const rows = [['nama_file', 'angka', 'jumlah_angka', 'keyakinan_persen']];
  for (const it of items) {
    rows.push([it.name, it.numbers.join(' | '), String(it.numbers.length), confText(it.confidence)]);
  }
  return rows;
}

/**
 * @param {string[][]} rows
 * @param {string} delimiter  "," atau ";" (Excel dengan pengaturan regional
 *                            Indonesia memakai ";" sebagai pemisah daftar)
 */
export function toCSV(rows, delimiter = ',') {
  // Hanya kolom nama file (indeks 0) yang dinetralkan: kolom angka berasal dari
  // regex angka (atau ketikan pengguna) sehingga "-12" harus tetap utuh.
  const body = rows.map((row, r) =>
    row
      .map((cell, c) => csvCell(r > 0 && c === 0 ? neutralizeFormula(String(cell)) : cell, delimiter))
      .join(delimiter));
  return `﻿${body.join('\r\n')}\r\n`; // BOM agar Excel membaca UTF-8
}

/** Format tab-separated untuk ditempel langsung ke Excel/Google Sheets. */
export function toTSV(rows) {
  const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  return rows.map((row) => row.map(clean).join('\t')).join('\n');
}

// ---------- Gambar ----------

/**
 * Ukuran target untuk OCR: perkecil foto yang terlalu besar (lambat) dan
 * perbesar gambar kecil (OCR butuh tinggi huruf yang cukup).
 */
export function fitSize(width, height, { maxLong = 2400, minLong = 900, maxUpscale = 3 } = {}) {
  const long = Math.max(width, height);
  let scale = 1;
  if (long > maxLong) scale = maxLong / long;
  else if (long < minLong) scale = Math.min(maxUpscale, minLong / long);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/** Ambang Otsu dari histogram 256 level. */
export function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Pra-proses piksel RGBA di tempat.
 * mode 'auto' : grayscale + regangkan kontras (persentil 1%-99%) + balik warna
 *               bila latar gelap (teks terang di latar gelap).
 * mode 'bw'   : seperti 'auto' lalu binarisasi Otsu (hitam-putih).
 * mode 'none' : tidak diubah.
 */
export function preprocessPixels(data, mode) {
  if (mode === 'none') return;
  const n = data.length / 4;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    gray[i] = g;
    hist[gray[i]]++;
    sum += gray[i];
  }

  // Regangkan kontras berdasarkan persentil 1% dan 99%.
  const cut = n * 0.01;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255; lo++) { acc += hist[lo]; if (acc > cut) break; }
  for (let acc = 0; hi > 0; hi--) { acc += hist[hi]; if (acc > cut) break; }
  const range = Math.max(1, hi - lo);
  const stretched = new Uint8ClampedArray(n);
  const hist2 = new Uint32Array(256);
  let sum2 = 0;
  for (let i = 0; i < n; i++) {
    const v = ((gray[i] - lo) * 255) / range;
    stretched[i] = v;
    hist2[stretched[i]]++;
    sum2 += stretched[i];
  }

  const invert = sum2 / n < 110; // latar gelap -> balik
  const threshold = mode === 'bw' ? otsuThreshold(hist2, n) : -1;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let v = stretched[i];
    if (threshold >= 0) v = v > threshold ? 255 : 0;
    if (invert) v = 255 - v;
    data[p] = data[p + 1] = data[p + 2] = v;
    data[p + 3] = 255;
  }
  return { invert, mean: sum / n };
}

// ---------- Format tampilan ----------

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} dtk`;
  return `${Math.floor(s / 60)} mnt ${s % 60} dtk`;
}

/** Kunci unik file untuk mendeteksi unggahan ganda. */
export function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif|avif|tiff?)$/i;
const UNSUPPORTED_EXT = /\.(heic|heif)$/i;

/** 'ok' | 'unsupported' (HEIC dsb.) | 'skip' (bukan gambar). */
export function classifyFile(file) {
  if (UNSUPPORTED_EXT.test(file.name) || /heic|heif/i.test(file.type)) return 'unsupported';
  if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'ok';
  return 'skip';
}
