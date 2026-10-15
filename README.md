# OCR Angka Massal

Web untuk membaca **angka** dari **banyak foto sekaligus**. Seluruh OCR berjalan di browser
([Tesseract.js](https://github.com/naptha/tesseract.js)), jadi foto **tidak dikirim ke server mana pun**
dan aplikasi bisa dipakai offline setelah dimuat.

## Menjalankan

Butuh Node.js 18+ (hanya untuk server statis kecil; tanpa dependensi, tidak perlu `npm install`).

```bash
npm start
# buka http://localhost:8080
```

Port/host bisa diganti: `PORT=3000 HOST=0.0.0.0 npm start`.

> Buka lewat server, jangan klik dua kali `index.html`: browser memblokir Web Worker dari `file://`.

Karena sepenuhnya statis, folder ini juga bisa langsung di-host di GitHub Pages, Netlify, Nginx, dll.
Pastikan file `.gz` disajikan **apa adanya** (tanpa `Content-Encoding: gzip`), karena Tesseract.js
mendekompresinya sendiri.

## Fitur

- Unggah banyak foto: pilih file, pilih **folder**, **tarik & lepas** (termasuk folder), atau **tempel** (Ctrl+V).
- Diproses paralel (default 2–3 worker, bisa diatur 1–8) dengan progres per foto, progres total, dan perkiraan sisa waktu.
- Tombol **Berhenti** / lanjutkan, **ulangi** per foto, dan hapus per foto.
- Tiap angka punya tingkat keyakinan. Baris diberi badge hijau/kuning/merah berdasarkan angka **paling meragukan**,
  dan angka yang meragukan disebut di catatan ("Periksa: 3, 5.000").
- Hasil bisa **diedit langsung** (pisahkan beberapa angka dengan spasi); klik thumbnail untuk melihat foto asli dan teks mentah OCR.
- Ekspor **CSV** (pemisah `;` untuk Excel pengaturan Indonesia, atau `,`) dan **Salin ke Excel/Sheets** (TSV).
  Pilihan *satu baris per gambar* atau *satu baris per angka*.
- Perbaikan gambar otomatis sebelum OCR: perkecil foto raksasa, perbesar gambar kecil, regangkan kontras,
  balik warna untuk teks terang di latar gelap, latar putih untuk PNG transparan, opsi hitam-putih (Otsu).
  Foto asli tidak diubah.
- Tema terang/gelap mengikuti sistem; tampilan responsif sampai layar ponsel.

## Tips akurasi

| Isi foto | Pengaturan |
| --- | --- |
| Struk, nota, label (angka bercampur teks) | **Mode angka murni: mati** (default). Angka diambil dari teks hasil OCR. |
| Hanya angka (meteran, nomor seri, plat) | Nyalakan **Mode angka murni**. Huruf dipaksa jadi angka sehingga mengurangi salah baca `O`/`0`, `l`/`1`. |
| Satu baris angka | Tata letak **Satu baris saja**. |
| Banyak angka berserakan | Tata letak **Angka tersebar**. |
| Foto buram / bayangan | Perbaikan gambar **Hitam-putih**. |

Mode angka murni bukan untuk foto bertulisan: huruf seperti `x` dibuang sehingga `3 x 5.000` bisa terbaca `35.000`
(dan keyakinannya 0%, jadi baris itu ditandai merah).

Hasil OCR bisa keliru. Selalu periksa baris bertanda kuning/merah.

## Batasan

- Memakai build WebAssembly **SIMD** (Chrome/Edge 91+, Firefox 89+, Safari 16.4+).
- Format **HEIC/HEIF** (foto iPhone tertentu) belum didukung browser; konversi dulu ke JPG.
- Hanya bahasa Inggris (`eng`) yang disertakan; itu cukup untuk digit.
- Hasil tidak disimpan di server. Muat ulang halaman = daftar hilang, jadi ekspor dulu.

## Struktur

```
index.html          halaman
css/style.css       tampilan
js/app.js           UI, antrean, worker OCR, ekspor
js/lib.js           fungsi murni (ekstraksi angka, CSV, pra-proses piksel)
server.js           server statis tanpa dependensi
tests/lib.test.js   unit test (npm test)
vendor/             tesseract.js, core WASM (SIMD+LSTM), data bahasa eng (best_int)
```

## Tes

```bash
npm test
```

## Lisensi pihak ketiga

`vendor/` berisi Tesseract.js dan Tesseract.js-core (Apache-2.0, lisensi disertakan) serta data bahasa
`eng.traineddata` dari proyek Tesseract (Apache-2.0), versi 7.0.0 / `4.0.0_best_int`.
