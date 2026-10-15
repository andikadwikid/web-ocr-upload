import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildExportRows,
  cardStatus,
  classifyFile,
  groupDigits,
  lowestConfidence,
  luhnValid,
  normalizeCardValue,
  parseManualNumbers,
  toCSV,
  toTSV,
} from '../js/lib.js';

const CARD = '6032981234567899'; // lolos Luhn

test('luhnValid: nomor valid, satu digit salah, dan input bukan digit', () => {
  assert.equal(luhnValid(CARD), true);
  assert.equal(luhnValid('6032981234567890'), false);
  assert.equal(luhnValid(''), false);
  assert.equal(luhnValid('6032 9812'), false);
});

test('luhnValid: setiap kesalahan satu digit terdeteksi', () => {
  for (let pos = 0; pos < CARD.length; pos++) {
    for (const d of '0123456789') {
      if (d !== CARD[pos]) assert.equal(luhnValid(CARD.slice(0, pos) + d + CARD.slice(pos + 1)), false, `${pos}:${d}`);
    }
  }
});

test('groupDigits & normalizeCardValue', () => {
  assert.equal(groupDigits(CARD), '6032 9812 3456 7899');
  assert.equal(groupDigits('12345'), '1234 5');
  assert.equal(normalizeCardValue(' 6032981234567899 '), '6032 9812 3456 7899');
  assert.equal(normalizeCardValue('6032-9812-3456-7899'), '6032 9812 3456 7899');
  assert.equal(normalizeCardValue('ABC 123'), 'ABC 123'); // bukan murni angka: dibiarkan
});

test('cardStatus: panjang & Luhn; null bila tidak berlaku', () => {
  const opt = { mode: 'card', length: 16, luhn: true };
  assert.deepEqual(cardStatus('6032 9812 3456 7899', opt), { digits: CARD, lengthOk: true, luhn: true });
  assert.deepEqual(cardStatus('6032 9812 3456 7890', opt), { digits: '6032981234567890', lengthOk: true, luhn: false });
  assert.deepEqual(cardStatus('6032 9812 3456 789', opt), { digits: '603298123456789', lengthOk: false, luhn: null });
  assert.equal(cardStatus(CARD, { ...opt, luhn: false }).luhn, null);
  assert.deepEqual(cardStatus('65.000', { mode: 'any', length: 16, luhn: true }), { digits: '65.000', lengthOk: null, luhn: null });
});

test('parseManualNumbers: spasi ada di dalam nomor, pemisah antar-nomor ; | atau baris baru', () => {
  assert.deepEqual(parseManualNumbers('6032 9812 3456 7899 ; 4539 5787 6362 1486'), ['6032 9812 3456 7899', '4539 5787 6362 1486']);
  assert.deepEqual(parseManualNumbers('a|b\nc'), ['a', 'b', 'c']);
  assert.deepEqual(parseManualNumbers('   '), []);
});

test('lowestConfidence: memakai nilai terendah agar angka ragu-ragu tidak tersembunyi', () => {
  assert.equal(lowestConfidence([]), null);
  assert.equal(lowestConfidence([96, 42, 90]), 42);
});

const items = [
  { name: 'a.jpg', numbers: [{ value: '6032 9812 3456 7899', luhn: true }, { value: '1234 5678 1234 5678', luhn: false }], confidence: 91.6 },
  { name: 'b.jpg', numbers: [], confidence: null },
  { name: 'c.jpg', numbers: [{ value: '65.000', luhn: null }], confidence: 80 },
];

test('buildExportRows: satu baris per gambar', () => {
  assert.deepEqual(buildExportRows(items, { card: true }), [
    ['nama_file', 'nomor_kartu', 'jumlah', 'keyakinan_persen', 'luhn'],
    ['a.jpg', '6032 9812 3456 7899 | 1234 5678 1234 5678', '2', '92', 'tidak_valid'],
    ['b.jpg', '', '0', '', ''],
    ['c.jpg', '65.000', '1', '80', ''],
  ]);
  assert.equal(buildExportRows(items)[0][1], 'angka');
});

test('buildExportRows: luhn gambar = valid hanya bila semua nomornya valid', () => {
  const one = [{ name: 'x.jpg', numbers: [{ value: 'v', luhn: true }], confidence: 90 }];
  assert.equal(buildExportRows(one)[1][4], 'valid');
});

test('buildExportRows: satu baris per angka, gambar tanpa angka tetap muncul', () => {
  assert.deepEqual(buildExportRows(items, { perNumber: true, card: true }), [
    ['nama_file', 'urutan', 'nomor_kartu', 'keyakinan_persen', 'luhn'],
    ['a.jpg', '1', '6032 9812 3456 7899', '92', 'valid'],
    ['a.jpg', '2', '1234 5678 1234 5678', '92', 'tidak_valid'],
    ['b.jpg', '', '', '', ''],
    ['c.jpg', '1', '65.000', '80', ''],
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

test('toTSV: tab dan baris baru di dalam sel dibersihkan; nomor berspasi tetap utuh', () => {
  assert.equal(toTSV([['a\tb', 'c\nd'], ['1', '6032 9812 3456 7899']]), 'a b\tc d\n1\t6032 9812 3456 7899');
});

test('classifyFile', () => {
  assert.equal(classifyFile({ name: 'a.jpg', type: 'image/jpeg' }), 'ok');
  assert.equal(classifyFile({ name: 'a.PNG', type: '' }), 'ok');
  assert.equal(classifyFile({ name: 'a.heic', type: 'image/heic' }), 'unsupported');
  assert.equal(classifyFile({ name: 'a.txt', type: 'text/plain' }), 'skip');
  assert.equal(classifyFile({ name: '.DS_Store', type: '' }), 'skip');
});
