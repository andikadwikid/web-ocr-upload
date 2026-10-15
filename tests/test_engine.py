"""Tes integrasi mesin OCR dengan gambar kartu sintetis (dilewati bila rapidocr belum terpasang)."""

import io
import random
import unittest

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    from ocr.engine import CardOCR, ImageError, decode_image
    HAVE_OCR = True
    try:
        import rapidocr_onnxruntime  # noqa: F401
    except ImportError:
        HAVE_OCR = False
except ImportError:
    HAVE_OCR = False

from ocr.cardnum import luhn_valid

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def make_card_jpeg(number: str, seed: int = 1, size: int = 64) -> bytes:
    """Latar warna-warni ber-noise (seperti kartu berkilau) dengan nomor putih."""
    rng = np.random.RandomState(seed)
    w, h = 1500, 1000
    x = np.linspace(0, 1, w)[None, :]
    y = np.linspace(0, 1, h)[:, None]
    t = (np.sin((x + y) * 8) * 0.5 + 0.5)[..., None]
    img = np.array((20, 130, 40), np.float32) * (1 - t) + np.array((30, 60, 160), np.float32) * t
    img += rng.normal(0, 22, img.shape)
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    try:
        font = ImageFont.truetype(FONT, size)
    except OSError:
        font = ImageFont.load_default(size)
    ImageDraw.Draw(im).text((120, 600), " ".join(number[i:i + 4] for i in range(0, 16, 4)), font=font, fill="white")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    return buf.getvalue()


def luhn_number(seed: int, valid: bool = True) -> str:
    rng = random.Random(seed)
    while True:
        s = "".join(rng.choice("0123456789") for _ in range(16))
        if luhn_valid(s) == valid:
            return s


class DecodeTest(unittest.TestCase):
    @unittest.skipUnless(HAVE_OCR, "rapidocr belum terpasang")
    def test_garbage_bytes_raise_image_error(self):
        with self.assertRaises(ImageError):
            decode_image(b"bukan gambar")


@unittest.skipUnless(HAVE_OCR, "rapidocr belum terpasang (pip install -r requirements.txt)")
class EngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = CardOCR()

    def test_reads_valid_card_number_in_first_pass(self):
        number = luhn_number(3)
        result = self.engine.read(make_card_jpeg(number))
        self.assertEqual([n["digits"] for n in result.numbers], [number])
        self.assertTrue(result.numbers[0]["luhn"])
        self.assertEqual(result.passes, ["asli"])  # tidak perlu percobaan ulang

    def test_invalid_checksum_is_flagged_after_trying_all_variants(self):
        number = luhn_number(5, valid=False)
        result = self.engine.read(make_card_jpeg(number))
        self.assertEqual(result.numbers[0]["digits"], number)
        self.assertIs(result.numbers[0]["luhn"], False)
        self.assertGreater(len(result.passes), 1)  # sudah mencoba variasi lain

    def test_luhn_check_can_be_disabled(self):
        number = luhn_number(5, valid=False)
        result = self.engine.read(make_card_jpeg(number), check_luhn=False)
        self.assertIsNone(result.numbers[0]["luhn"])
        self.assertEqual(result.passes, ["asli"])

    def test_any_mode_returns_every_number(self):
        result = self.engine.read(make_card_jpeg(luhn_number(7)), mode="any")
        self.assertTrue(result.numbers)
        self.assertEqual(result.passes, ["asli"])


if __name__ == "__main__":
    unittest.main()
