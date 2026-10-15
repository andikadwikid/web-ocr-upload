import io
import unittest

from ocr.engine import ImageError
from server import create_app


class FakeResult:
    def __init__(self, payload):
        self.payload = payload

    def to_dict(self):
        return self.payload


class FakeEngine:
    def __init__(self):
        self.calls = []

    def read(self, data, *, mode, length, check_luhn, max_passes=None):
        self.calls.append((data, mode, length, check_luhn, max_passes))
        if data == b"bad":
            raise ImageError("Gambar rusak")
        return FakeResult({"numbers": [{"value": "6032 9812 3456 7899"}], "raw_text": "", "passes": ["asli"],
                           "best_pass": "asli", "elapsed_ms": 1})


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.client = create_app(lambda: self.engine).test_client()

    def post(self, data=b"img", **form):
        return self.client.post("/api/ocr", data={"file": (io.BytesIO(data), "a.jpg"), **form},
                                content_type="multipart/form-data")

    def test_health(self):
        self.assertEqual(self.client.get("/api/health").get_json()["ok"], True)

    def test_ocr_passes_defaults_and_options(self):
        r = self.post()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["numbers"][0]["value"], "6032 9812 3456 7899")
        self.assertEqual(self.engine.calls[-1], (b"img", "card", 16, True, None))
        self.post(mode="any", length="12", luhn="0")
        self.assertEqual(self.engine.calls[-1], (b"img", "any", 12, False, None))
        self.post(passes="1")
        self.assertEqual(self.engine.calls[-1], (b"img", "card", 16, True, 1))

    def test_validation_errors(self):
        self.assertEqual(self.client.post("/api/ocr").status_code, 400)
        self.assertEqual(self.post(mode="x").status_code, 400)
        self.assertEqual(self.post(length="abc").status_code, 400)
        self.assertEqual(self.post(length="3").status_code, 400)
        self.assertEqual(self.post(length="99").status_code, 400)
        self.assertEqual(self.post(passes="0").status_code, 400)
        self.assertEqual(self.post(passes="6").status_code, 400)
        self.assertEqual(self.post(passes="x").status_code, 400)
        self.assertEqual(self.engine.calls, [])

    def test_unreadable_image_is_422_with_message(self):
        r = self.post(data=b"bad")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.get_json()["error"], "Gambar rusak")

    def status(self, path):
        with self.client.get(path) as response:  # tutup respons agar file stream dilepas
            return response.status_code

    def test_static_files_whitelist_and_traversal(self):
        for path in ("/", "/index.html", "/js/app.js", "/js/lib.js", "/css/style.css"):
            self.assertEqual(self.status(path), 200, path)
        for path in ("/server.py", "/requirements.txt", "/ocr/engine.py", "/tests/test_server.py",
                     "/.git/config", "/js/../server.py", "/js/../.git/config", "/js/./../server.py",
                     "/css/../ocr/engine.py", "/%2e%2e/server.py", "/js/%2e%2e/server.py",
                     "/js\\..\\server.py", "/js/.hidden", "/nonexistent", "/js/"):
            self.assertEqual(self.status(path), 404, path)

    def test_upload_too_large(self):
        app = create_app(lambda: self.engine)
        app.config["MAX_CONTENT_LENGTH"] = 10
        r = app.test_client().post("/api/ocr", data={"file": (io.BytesIO(b"x" * 100), "a.jpg")},
                                   content_type="multipart/form-data")
        self.assertEqual(r.status_code, 413)
        self.assertIn("error", r.get_json())


if __name__ == "__main__":
    unittest.main()
