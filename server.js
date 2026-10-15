// Server statis kecil tanpa dependensi: `npm start` lalu buka http://localhost:8080
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

// Hanya yang dibutuhkan aplikasi; selain ini tidak disajikan.
const PUBLIC = ['index.html', 'css', 'js', 'vendor'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  // .gz sengaja BUKAN Content-Encoding: tesseract.js mendekompresi sendiri.
  '.gz': 'application/gzip',
};

function resolveRequest(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = normalize(decoded === '/' ? '/index.html' : decoded).replace(/^[/\\]+/, '');
  const full = join(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  const top = rel.split(/[/\\]/)[0];
  return PUBLIC.includes(top) ? full : null;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const file = resolveRequest(new URL(req.url, 'http://localhost').pathname);
  try {
    const info = file && (await stat(file));
    if (!info?.isFile()) throw new Error('not found');
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'X-Content-Type-Options': 'nosniff',
      // Aset besar di vendor/ tidak berubah; kode aplikasi selalu divalidasi ulang.
      'Cache-Control': file.includes(`${sep}vendor${sep}`) ? 'public, max-age=86400' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Tidak ditemukan');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OCR Angka Massal berjalan di http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
