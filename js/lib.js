// Fungsi murni (tanpa DOM) supaya bisa dipakai di browser dan diuji di Node.

// ---------- Nomor kartu ----------

/** Checksum Luhn (ISO/IEC 7812) untuk string digit. */
export function luhnValid(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

/** '6032981234567899' -> '6032 9812 3456 7899'. */
export function groupDigits(digits, size = 4) {
  return digits.match(new RegExp(`\\d{1,${size}}`, 'g'))?.join(' ') ?? '';
}

/**
 * Rapikan isian nomor kartu: bila isinya hanya digit/spasi/strip, kelompokkan 4-4-4-4.
 * Teks lain dibiarkan apa adanya.
 */
export function normalizeCardValue(value) {
  const v = value.trim();
  return /^[\d\s-]+$/.test(v) ? groupDigits(v.replace(/\D/g, '')) : v;
}

/**
 * Status validasi satu nilai.
 * @returns {{digits:string, lengthOk:boolean|null, luhn:boolean|null}}
 *   null = tidak berlaku (mode 'semua angka' / Luhn dimatikan).
 */
export function cardStatus(value, { mode, length, luhn }) {
  if (mode !== 'card') return { digits: value, lengthOk: null, luhn: null };
  const digits = value.replace(/\D/g, '');
  const lengthOk = digits.length === length;
  return { digits, lengthOk, luhn: luhn && lengthOk ? luhnValid(digits) : null };
}

/** Pecah isian manual pengguna: dipisah titik koma, | atau baris baru (spasi dipakai di dalam nomor kartu). */
export function parseManualNumbers(input) {
  return input
    .split(/[;|\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Confidence terendah (0-100) dari daftar; null bila kosong. Dipakai (bukan rata-rata)
 * karena satu angka yang salah sudah merusak data, jadi baris itu harus ditandai.
 */
export function lowestConfidence(confidences) {
  return confidences.length ? Math.min(...confidences) : null;
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

const luhnText = (flag) => (flag === true ? 'valid' : flag === false ? 'tidak_valid' : '');

/**
 * Susun baris ekspor dari daftar hasil.
 * @param {{name:string, numbers:{value:string, luhn:boolean|null}[], confidence:number|null}[]} items
 * @param {{perNumber?:boolean, card?:boolean}} opts  perNumber: satu baris per angka; card: kolom bernama nomor_kartu
 */
export function buildExportRows(items, { perNumber = false, card = false } = {}) {
  const label = card ? 'nomor_kartu' : 'angka';
  const conf = (c) => (c == null ? '' : String(Math.round(c)));
  if (perNumber) {
    const rows = [['nama_file', 'urutan', label, 'keyakinan_persen', 'luhn']];
    for (const it of items) {
      if (!it.numbers.length) rows.push([it.name, '', '', conf(it.confidence), '']);
      it.numbers.forEach((n, i) =>
        rows.push([it.name, String(i + 1), n.value, conf(it.confidence), luhnText(n.luhn)]));
    }
    return rows;
  }
  const rows = [['nama_file', label, 'jumlah', 'keyakinan_persen', 'luhn']];
  for (const it of items) {
    const flags = it.numbers.map((n) => n.luhn);
    let overall = null;
    if (flags.includes(false)) overall = false;
    else if (flags.length && flags.every((f) => f === true)) overall = true;
    rows.push([it.name, it.numbers.map((n) => n.value).join(' | '), String(it.numbers.length),
      conf(it.confidence), luhnText(overall)]);
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
  // OCR (atau ketikan pengguna) sehingga "-12" harus tetap utuh.
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

// ---------- Format tampilan & file ----------

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

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i;
const UNSUPPORTED_EXT = /\.(heic|heif|avif)$/i;

/** 'ok' | 'unsupported' (HEIC dsb.) | 'skip' (bukan gambar). */
export function classifyFile(file) {
  if (UNSUPPORTED_EXT.test(file.name) || /heic|heif|avif/i.test(file.type)) return 'unsupported';
  if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'ok';
  return 'skip';
}
