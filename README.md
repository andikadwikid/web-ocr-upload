# OCR Angka Massal — nomor kartu e-money dari banyak foto

Unggah banyak foto kartu (e-money, dll.) sekaligus, lalu nomor kartunya dibaca otomatis dan dicek dengan
**checksum Luhn** untuk mendeteksi digit yang salah baca. Hasil bisa diedit, diunduh sebagai CSV, atau
disalin langsung ke Excel/Google Sheets.

OCR dijalankan oleh server Python di komputer Anda sendiri (RapidOCR, model PaddleOCR lewat ONNX Runtime).
Foto **tidak dikirim ke internet**, dan tidak ada unduhan model: model ikut terpasang bersama library.

## Pasang & jalankan

Butuh Python 3 (diuji di 3.13) dan koneksi internet **hanya** saat `pip install`.

```bash
python -m venv .venv

# macOS / Linux
source .venv/bin/activate
# Windows (PowerShell)
.venv\Scripts\Activate.ps1

pip install -r requirements.txt
python server.py
```

Buka <http://localhost:8080>. Opsi: `python server.py --port 9000`, atau `--host 0.0.0.0` agar bisa dibuka
dari HP di jaringan Wi-Fi yang sama (hati-hati: siapa pun di jaringan itu bisa memakainya).

### Lewat Docker

Butuh Docker Desktop (atau Docker Engine) terpasang.

```bash
docker compose up --build
```

Buka <http://localhost:8080>. Untuk berhenti: `docker compose down`.

## Cara pakai

1. Pilih foto/folder, tarik & lepas, atau tempel (Ctrl+V).
2. Klik **Mulai OCR**. Tiap baris menampilkan nomor yang terbaca dan statusnya:
   - **Valid** (hijau): panjang pas dan checksum Luhn cocok.
   - **Periksa** (kuning): panjang salah atau checksum tidak cocok, kemungkinan ada digit salah baca.
     Nomornya tetap ditampilkan; koreksi langsung di kolom angka, statusnya ikut berubah saat Anda mengetik.
   - Baris kosong: nomor kartu tidak ditemukan di foto.
3. **Unduh CSV** atau **Salin ke Excel**. Klik thumbnail untuk melihat foto asli dan teks mentah hasil OCR.

Nomor ditulis berspasi (`6032 9812 3456 7899`) dengan sengaja: Excel membaca 16 digit tanpa spasi sebagai angka
dan memotongnya menjadi 15 digit signifikan, sedangkan yang berspasi tetap utuh sebagai teks.

### Pengaturan

| Pengaturan | Keterangan |
| --- | --- |
| Yang dibaca | **Nomor kartu** (default) atau **Semua angka** di foto (struk, label, dll.). |
| Panjang nomor kartu | Jumlah digit, default 16. |
| Cek checksum Luhn | Matikan bila jenis kartu Anda memang tidak memakai Luhn. |
| Proses paralel | Jumlah foto yang dikirim ke server bersamaan (1–4). |
| CSV | Pemisah `;` (Excel dengan pengaturan regional Indonesia) atau `,`; satu baris per foto atau per nomor. |

## Cara kerja

1. RapidOCR mendeteksi dan membaca semua teks di foto (foto menyamping dan miring tertangani).
2. Potongan angka dalam satu baris digabung (OCR sering memecah `6032 9812 3456 7899` jadi beberapa kotak),
   huruf yang mirip angka dikoreksi (`O`→`0`, `l`→`1`, `S`→`5`, ...) hanya pada kata yang sebagian besar angka,
   dan hanya urutan yang totalnya **tepat 16 digit** diterima.
3. Bila hasilnya belum 16 digit yang lolos Luhn, foto dicoba ulang dengan variasi (kontras ditingkatkan, diperbesar,
   diputar 90°) dan hasil terbaik dipakai. Percobaan berhenti begitu ada hasil yang valid, jadi foto yang mudah tetap cepat.

## Seberapa akurat?

Diuji pada **69 gambar**: 19 variasi dari satu foto kartu e-money asli (diputar, diperkecil sampai ±0,18×, diburamkan,
dikompres berat, digelapkan/dicerahkan, silau, perspektif, di-crop, menyamping) dan 50 kartu sintetis berlatar
warna-warni (teks kecil, kontras rendah, buram berat, silau, perspektif). Hasilnya **69 dari 69 benar**, sekitar
0,5-1 detik per foto di CPU biasa (foto 3000x2000 bisa sampai ±4 detik), dan tidak ada hasil salah.

Batasannya perlu dipahami:

- Pengujian memakai **satu** foto kartu asli (dan turunannya) plus gambar sintetis, bukan ribuan foto nyata dari
  berbagai jenis kartu. Coba dengan foto Anda sendiri.
- Luhn bukan jaminan: hasil salah masih lolos dengan peluang sekitar 10%. Sebaliknya, tidak semua jenis kartu
  dijamin memakai Luhn. Nomor di foto contoh lolos, tetapi bila kartu Anda yang lain selalu "Periksa" padahal
  digitnya benar, matikan opsi Luhn.
- Foto yang buram sekali atau nomor yang tertutup silau pasti tetap bisa gagal; itulah gunanya tanda "Periksa".

## Batasan

- HEIC/HEIF/AVIF (foto iPhone tertentu) belum didukung; ekspor dulu ke JPG.
- Pemrosesan berjalan satu foto per satu di server (ONNX Runtime sudah memakai semua core CPU), jadi
  "Proses paralel" hanya menumpuk upload/decode, bukan melipatgandakan kecepatan OCR.
- Hasil tidak disimpan. Memuat ulang halaman mengosongkan daftar, jadi ekspor dulu.

## API

```
GET  /api/health
POST /api/ocr    multipart: file, mode=card|any (default card), length=8..24 (default 16), luhn=1|0
→ { "numbers": [{"value": "6032 9812 3456 7899", "digits": "...", "confidence": 84.9,
                 "luhn": true, "length_ok": true, "note": ""}],
    "raw_text": "...", "passes": ["asli"], "best_pass": "asli", "elapsed_ms": 910 }
```

## Struktur

```
server.py           Flask + waitress: menyajikan halaman dan /api/ocr
ocr/cardnum.py      ekstraksi nomor kartu & Luhn (murni, mudah diuji)
ocr/engine.py       RapidOCR + percobaan ulang bervariasi
index.html css/ js/ antarmuka web (JS biasa, tanpa build)
tests/              unit test Python (unittest) dan JavaScript (node --test)
```

## Tes

```bash
python -m unittest discover -s tests -t .   # Python (tes mesin OCR dilewati bila rapidocr belum terpasang)
npm test                                    # opsional: tes JavaScript, butuh Node 18+
```

## Lisensi pihak ketiga

[RapidOCR](https://github.com/RapidAI/RapidOCR) (Apache-2.0) membawa model PaddleOCR (Apache-2.0).
Flask, waitress, ONNX Runtime, OpenCV, NumPy, dan Pillow dipasang lewat pip dengan lisensinya masing-masing.
