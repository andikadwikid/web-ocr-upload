import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  lowestConfidence,
  buildExportRows,
  classifyFile,
  extractFromPage,
  extractNumbers,
  fitSize,
  otsuThreshold,
  parseManualNumbers,
  preprocessPixels,
  toCSV,
  toTSV,
} from '../js/lib.js';

test('extractNumbers: bilangan bulat, desimal, ribuan, negatif', () => {
  assert.deepEqual(extractNumbers('Total 12 345 dan 3.14, 1,234.56 serta -7'), ['12', '345', '3.14', '1,234.56', '-7']);
  assert.deepEqual(extractNumbers('1.234,56'), ['1.234,56']);
});

test('extractNumbers: tanda hubung di antara angka bukan tanda negatif', () => {
  assert.deepEqual(extractNumbers('0812-3456-7890'), ['0812', '3456', '7890']);
  assert.deepEqual(extractNumbers('suhu -5 derajat'), ['-5']);
});

test('extractNumbers: pemisah di ujung dibuang, teks tanpa angka kosong', () => {
  assert.deepEqual(extractNumbers('harga 100. lalu 200,'), ['100', '200']);
  assert.deepEqual(extractNumbers('tidak ada angka'), []);
  assert.deepEqual(extractNumbers(''), []);
  assert.deepEqual(extractNumbers(undefined), []);
});

test('extractFromPage: memakai confidence per kata', () => {
  const page = {
    confidence: 50,
    text: '12 abc 34',
    blocks: [{ paragraphs: [{ lines: [{ words: [
      { text: '12', confidence: 96.4 },
      { text: 'abc', confidence: 20 },
      { text: '34', confidence: 71 },
    ] }] }] }],
  };
  assert.deepEqual(extractFromPage(page), [
    { value: '12', confidence: 96.4 },
    { value: '34', confidence: 71 },
  ]);
});

test('extractFromPage: tanpa blocks jatuh ke teks + confidence halaman', () => {
  assert.deepEqual(extractFromPage({ text: 'a 5 b 6', confidence: 88 }), [
    { value: '5', confidence: 88 },
    { value: '6', confidence: 88 },
  ]);
  assert.deepEqual(extractFromPage(null), []);
});

test('lowestConfidence: memakai nilai terendah agar angka ragu-ragu tidak tersembunyi', () => {
  assert.equal(lowestConfidence([]), null);
  assert.equal(lowestConfidence([{ confidence: 96 }, { confidence: 42 }, { confidence: 90 }]), 42);
});

test('parseManualNumbers: pisah spasi/titik koma', () => {
  assert.deepEqual(parseManualNumbers(' 12  34;56 '), ['12', '34', '56']);
  assert.deepEqual(parseManualNumbers('   '), []);
});

const items = [
  { name: 'a.jpg', numbers: ['12', '1,5'], confidence: 91.6 },
  { name: 'b.jpg', numbers: [], confidence: null },
];

test('buildExportRows: satu baris per gambar', () => {
  assert.deepEqual(buildExportRows(items), [
    ['nama_file', 'angka', 'jumlah_angka', 'keyakinan_persen'],
    ['a.jpg', '12 | 1,5', '2', '92'],
    ['b.jpg', '', '0', ''],
  ]);
});

test('buildExportRows: satu baris per angka, gambar tanpa angka tetap muncul', () => {
  assert.deepEqual(buildExportRows(items, { perNumber: true }), [
    ['nama_file', 'urutan', 'angka', 'keyakinan_persen'],
    ['a.jpg', '1', '12', '92'],
    ['a.jpg', '2', '1,5', '92'],
    ['b.jpg', '', '', ''],
  ]);
});

test('toCSV: BOM, kutip, delimiter, dan netralisasi rumus pada nama file', () => {
  const rows = [['nama_file', 'angka'], ['=cmd|x.jpg', '-12'], ['a,"b".jpg', '1,5']];
  const csv = toCSV(rows, ',');
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[1], "'=cmd|x.jpg,-12"); // angka negatif tidak dirusak
  assert.equal(lines[2], '"a,""b"".jpg","1,5"');
  assert.equal(toCSV([['x', '1,5']], ';').slice(1).trim(), 'x;1,5'); // koma tidak perlu kutip bila delimiter ';'
  assert.equal(toCSV([['x', '1;5']], ';').slice(1).trim(), 'x;"1;5"');
});

test('toTSV: tab dan baris baru di dalam sel dibersihkan', () => {
  assert.equal(toTSV([['a\tb', 'c\nd'], ['1', '2']]), 'a b\tc d\n1\t2');
});

test('fitSize: perkecil yang besar, perbesar yang kecil, biarkan yang sedang', () => {
  assert.deepEqual(fitSize(4800, 3200), { width: 2400, height: 1600, scale: 0.5 });
  assert.deepEqual(fitSize(300, 100), { width: 900, height: 300, scale: 3 });
  assert.deepEqual(fitSize(10, 10), { width: 30, height: 30, scale: 3 });
  assert.deepEqual(fitSize(1200, 800), { width: 1200, height: 800, scale: 1 });
});

test('otsuThreshold: memisahkan dua puncak histogram', () => {
  const hist = new Uint32Array(256);
  hist[30] = 500;
  hist[220] = 500;
  const t = otsuThreshold(hist, 1000);
  assert.ok(t >= 30 && t < 220, `ambang ${t}`);
});

function rgba(values) {
  const data = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  return data;
}

test('preprocessPixels: balik warna untuk teks terang di latar gelap', () => {
  // 90% piksel gelap (latar), 10% terang (teks)
  const values = [...Array(90).fill(20), ...Array(10).fill(230)];
  const data = rgba(values);
  const info = preprocessPixels(data, 'auto');
  assert.equal(info.invert, true);
  assert.ok(data[0] > 200, 'latar menjadi terang'); // piksel latar
  assert.ok(data[95 * 4] < 60, 'teks menjadi gelap'); // piksel teks
});

test('preprocessPixels: mode bw menghasilkan hanya 0 atau 255; mode none tidak mengubah', () => {
  const data = rgba([...Array(50).fill(200), ...Array(50).fill(60)]);
  preprocessPixels(data, 'bw');
  for (let i = 0; i < data.length; i += 4) assert.ok(data[i] === 0 || data[i] === 255);

  const same = rgba([10, 120, 240]);
  const copy = same.slice();
  preprocessPixels(same, 'none');
  assert.deepEqual(same, copy);
});

test('classifyFile', () => {
  assert.equal(classifyFile({ name: 'a.jpg', type: 'image/jpeg' }), 'ok');
  assert.equal(classifyFile({ name: 'a.PNG', type: '' }), 'ok');
  assert.equal(classifyFile({ name: 'a.heic', type: 'image/heic' }), 'unsupported');
  assert.equal(classifyFile({ name: 'a.txt', type: 'text/plain' }), 'skip');
  assert.equal(classifyFile({ name: '.DS_Store', type: '' }), 'skip');
});
