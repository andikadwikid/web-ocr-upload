"""Mesin OCR (RapidOCR / model PaddleOCR via ONNX Runtime) untuk nomor kartu.

Model sudah ikut terpasang bersama paket `rapidocr-onnxruntime`, jadi tidak ada
unduhan tambahan dan bisa dipakai offline.
"""

from __future__ import annotations

import io
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Iterator

import cv2
import numpy as np
from PIL import Image, ImageOps

from .cardnum import Candidate, Line, find_card_numbers, find_numbers, summarize

# ONNX Runtime (build pip) memuat SDK telemetri Microsoft yang mencoba menghubungi
# mobile.events.data.microsoft.com beberapa detik setelah model dimuat. Fungsi
# onnxruntime.disable_telemetry_events() terukur TIDAK menghentikannya; variabel ini yang efektif.
# Harus diatur sebelum onnxruntime diimpor/dipakai.
os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")

MAX_SIDE = 2400  # foto kamera 12 MP diperkecil agar OCR tidak lambat


class ImageError(ValueError):
    """Berkas bukan gambar yang bisa dibaca."""


@dataclass
class OcrResult:
    numbers: list[dict]
    raw_text: str
    passes: list[str]
    best_pass: str
    elapsed_ms: int
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "numbers": self.numbers,
            "raw_text": self.raw_text,
            "passes": self.passes,
            "best_pass": self.best_pass,
            "elapsed_ms": self.elapsed_ms,
        }


def decode_image(data: bytes) -> np.ndarray:
    """Bytes gambar -> array BGR. Orientasi EXIF diterapkan, transparansi jadi putih."""
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            background = Image.new("RGBA", img.size, (255, 255, 255, 255))
            img = Image.alpha_composite(background, img)
        img = img.convert("RGB")
    except Exception as exc:  # PIL melempar banyak jenis error
        raise ImageError("Gambar rusak atau formatnya tidak didukung") from exc

    if max(img.size) > MAX_SIDE:
        scale = MAX_SIDE / max(img.size)
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    return cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)


def variants(img: np.ndarray) -> Iterator[tuple[str, np.ndarray]]:
    """Variasi gambar yang dicoba berurutan sampai ada nomor yang valid (lazy)."""
    yield "asli", img

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    boosted = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(gray)
    yield "kontras", cv2.cvtColor(boosted, cv2.COLOR_GRAY2BGR)

    if max(img.shape[:2]) < 1600:
        yield "perbesar", cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)

    # Kartu yang difoto menyamping (EXIF tidak selalu ada).
    yield "putar-kanan", cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    yield "putar-kiri", cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)


def _to_lines(result) -> list[Line]:
    lines = []
    for box, text, score in result or []:
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        lines.append(Line(
            text=str(text),
            confidence=float(score) * 100,
            cx=sum(xs) / len(xs),
            cy=sum(ys) / len(ys),
            height=max(ys) - min(ys),
        ))
    return lines


class CardOCR:
    """Satu instance dipakai bersama; pemanggilan diserialkan dengan lock.

    ONNX Runtime sudah memakai semua core CPU untuk satu gambar, jadi memproses
    gambar bersamaan tidak akan lebih cepat, hanya berisiko race condition.
    """

    def __init__(self) -> None:
        from rapidocr_onnxruntime import RapidOCR  # impor lambat: dilakukan saat dibutuhkan

        self._engine = RapidOCR()
        self._lock = threading.Lock()

    def _run(self, img: np.ndarray) -> list[Line]:
        with self._lock:
            result, _ = self._engine(img)
        return _to_lines(result)

    def read(self, data: bytes, *, mode: str = "card", length: int = 16,
             check_luhn: bool = True) -> OcrResult:
        started = time.perf_counter()
        img = decode_image(data)

        if mode == "any":
            lines = self._run(img)
            numbers = [c.to_dict() for c in find_numbers(lines)]
            return OcrResult(numbers, "\n".join(l.text for l in lines), ["asli"], "asli",
                             _ms(started))

        tried: list[str] = []
        best: tuple[tuple, list[Candidate], list[Line], str] | None = None
        for name, variant in variants(img):
            tried.append(name)
            lines = self._run(variant)
            cands = find_card_numbers(lines, length=length, check_luhn=check_luhn)
            score = summarize(cands)
            # Lebih banyak hasil valid menang; seri -> confidence tertinggi.
            if best is None or score > best[0]:
                best = (score, cands, lines, name)
            if cands and all(c.ok for c in cands):
                break  # sudah panjang pas dan lolos checksum: tidak perlu mencoba lagi

        assert best is not None
        _, cands, lines, best_name = best
        return OcrResult([c.to_dict() for c in cands], "\n".join(l.text for l in lines),
                         tried, best_name, _ms(started))


def _ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


_instance: CardOCR | None = None
_instance_lock = threading.Lock()


def get_engine() -> CardOCR:
    global _instance
    with _instance_lock:
        if _instance is None:
            _instance = CardOCR()
        return _instance
