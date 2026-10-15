"""Server web OCR nomor kartu: `python server.py` lalu buka http://127.0.0.1:8080

Menyajikan halaman (index.html, css/, js/) dan API OCR:
  GET  /api/health
  POST /api/ocr   multipart: file, mode=card|any, length=16, luhn=1|0
"""

from __future__ import annotations

import argparse
import threading
from pathlib import Path, PurePosixPath

from flask import Flask, abort, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent
PUBLIC = {"index.html", "css", "js"}  # hanya ini yang disajikan
MAX_UPLOAD_BYTES = 30 * 1024 * 1024
LENGTH_RANGE = (8, 24)


def is_public(name: str) -> bool:
    """Hanya path di dalam PUBLIC, tanpa segmen '.', '..', atau tersembunyi (.git, .env).

    `send_from_directory` hanya mencegah keluar dari ROOT; "js/../server.py" tetap
    di dalam ROOT, jadi daftar yang diizinkan harus diperiksa per segmen di sini.
    """
    if "\\" in name or "\0" in name:
        return False
    parts = PurePosixPath(name).parts
    return bool(parts) and parts[0] in PUBLIC and all(p not in ("", ".", "..") and not p.startswith(".") for p in parts)


def create_app(engine_factory=None) -> Flask:
    """`engine_factory` memberi objek dengan `.read(data, mode=, length=, check_luhn=)`.

    Default memuat RapidOCR secara lambat (pada permintaan pertama / pemanasan).
    """
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

    def get_engine():
        if engine_factory is not None:
            return engine_factory()
        from ocr.engine import get_engine as default_engine
        return default_engine()

    @app.get("/")
    def index():
        return send_from_directory(ROOT, "index.html")

    @app.get("/<path:name>")
    def static_files(name: str):
        if not is_public(name):
            abort(404)
        return send_from_directory(ROOT, name)

    @app.get("/api/health")
    def health():
        return jsonify(ok=True, engine="rapidocr-onnxruntime")

    @app.post("/api/ocr")
    def ocr():
        upload = request.files.get("file")
        if upload is None:
            return jsonify(error="Berkas 'file' tidak ada pada permintaan"), 400

        mode = request.form.get("mode", "card")
        if mode not in ("card", "any"):
            return jsonify(error="mode harus 'card' atau 'any'"), 400
        try:
            length = int(request.form.get("length", 16))
        except ValueError:
            return jsonify(error="length harus berupa bilangan bulat"), 400
        if not LENGTH_RANGE[0] <= length <= LENGTH_RANGE[1]:
            return jsonify(error=f"length harus {LENGTH_RANGE[0]}-{LENGTH_RANGE[1]}"), 400
        check_luhn = request.form.get("luhn", "1") != "0"

        from ocr.engine import ImageError  # ringan: engine.py baru memuat OCR saat get_engine()

        try:
            result = get_engine().read(upload.read(), mode=mode, length=length, check_luhn=check_luhn)
        except ImageError as exc:
            return jsonify(error=str(exc)), 422
        return jsonify(result.to_dict())

    @app.errorhandler(413)
    def too_large(_):
        return jsonify(error=f"Berkas lebih dari {MAX_UPLOAD_BYTES // 1024 // 1024} MB"), 413

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Web OCR nomor kartu")
    parser.add_argument("--host", default="127.0.0.1",
                        help="gunakan 0.0.0.0 agar bisa dibuka dari HP di jaringan yang sama")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    try:
        from waitress import serve

        import rapidocr_onnxruntime  # noqa: F401  (hanya memeriksa terpasang)
    except ImportError as exc:
        raise SystemExit(f"Library belum terpasang ({exc.name}). Jalankan: pip install -r requirements.txt")

    def warm_up() -> None:  # muat model di latar belakang agar foto pertama tidak menunggu
        from ocr.engine import get_engine
        get_engine()

    threading.Thread(target=warm_up, daemon=True).start()
    shown = "localhost" if args.host in ("0.0.0.0", "127.0.0.1") else args.host
    print(f"OCR Angka Massal berjalan di http://{shown}:{args.port}  (Ctrl+C untuk berhenti)")
    serve(create_app(), host=args.host, port=args.port, threads=4)


if __name__ == "__main__":
    main()
