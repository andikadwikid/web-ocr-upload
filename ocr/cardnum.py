"""Ekstraksi nomor kartu (mis. e-money 16 digit) dari hasil OCR.

Modul ini murni Python (tanpa numpy/OCR) supaya mudah diuji. Masukannya adalah
daftar baris teks hasil OCR beserta posisinya.

Alurnya:
  1. Baris dikelompokkan per "baris visual" lalu diurutkan kiri-ke-kanan, karena
     OCR sering memecah "6032 9812 3456 7899" menjadi beberapa potongan.
  2. Huruf yang mirip angka (O->0, l->1, S->5, ...) dikoreksi, tetapi hanya pada
     kata yang sebagian besar berisi angka.
  3. Potongan angka berurutan dalam satu baris digabung hingga totalnya tepat
     sepanjang nomor kartu. Hasilnya diberi peringkat memakai checksum Luhn.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from statistics import median

# Huruf yang sering salah dibaca untuk angka tertentu pada font nomor kartu.
CONFUSABLE = str.maketrans({
    "O": "0", "o": "0", "D": "0", "Q": "0",
    "I": "1", "l": "1", "|": "1", "!": "1", "i": "1",
    "Z": "2", "z": "2",
    "S": "5", "s": "5",
    "B": "8",
})

_DIGITS = re.compile(r"\d+")
_NUMBER = re.compile(r"(?<![\d.,])-?\d+(?:[.,]\d+)*")


@dataclass(frozen=True)
class Line:
    """Satu baris teks hasil OCR. Posisi dalam piksel; confidence 0-100."""

    text: str
    confidence: float
    cx: float = 0.0
    cy: float = 0.0
    height: float = 0.0


@dataclass(frozen=True)
class Token:
    digits: str
    confidence: float
    row: int


@dataclass
class Candidate:
    digits: str
    confidence: float
    luhn: bool | None  # None = tidak dicek
    length_ok: bool
    row: int = 0
    start: int = 0  # indeks token awal (untuk urutan baca & tumpang tindih)
    end: int = 0
    note: str = ""
    tokens: list[Token] = field(default_factory=list, repr=False)
    grouped: bool = True  # False untuk mode "semua angka" (tampilkan apa adanya)

    @property
    def ok(self) -> bool:
        """Panjang pas dan (bila dicek) lolos Luhn."""
        return self.length_ok and self.luhn is not False

    def to_dict(self) -> dict:
        return {
            "value": group_digits(self.digits) if self.grouped else self.digits,
            "digits": self.digits,
            "confidence": round(self.confidence, 1),
            "luhn": self.luhn,
            "length_ok": self.length_ok,
            "note": self.note,
        }


def luhn_valid(digits: str) -> bool:
    """Checksum Luhn (ISO/IEC 7812) untuk string digit."""
    if not digits or not digits.isdigit():
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def group_digits(digits: str, size: int = 4) -> str:
    """'6032981234567899' -> '6032 9812 3456 7899'.

    Sengaja berspasi: Excel membaca 16 digit tanpa spasi sebagai angka dan
    membulatkannya ke 15 digit signifikan, sedangkan yang berspasi tetap teks.
    """
    return " ".join(digits[i:i + size] for i in range(0, len(digits), size))


def fix_confusables(word: str) -> str:
    """Koreksi huruf mirip angka hanya bila kata itu setidaknya separuh angka.

    'l234' -> '1234', '34OO' -> '3400', tetapi 'B2' (cuma 1 digit) dan
    'TOKO' (tanpa digit) dibiarkan.
    """
    digits = sum(c.isdigit() for c in word)
    if digits < 2 or digits * 2 < len(word):
        return word
    return word.translate(CONFUSABLE)


def cluster_rows(lines: list[Line]) -> list[list[Line]]:
    """Kelompokkan baris OCR menjadi baris visual (atas ke bawah, kiri ke kanan)."""
    if not lines:
        return []
    heights = [ln.height for ln in lines if ln.height > 0]
    tolerance = 0.6 * (median(heights) if heights else 20.0)
    rows: list[list[Line]] = []
    for ln in sorted(lines, key=lambda l: l.cy):
        if rows and abs(ln.cy - sum(r.cy for r in rows[-1]) / len(rows[-1])) <= tolerance:
            rows[-1].append(ln)
        else:
            rows.append([ln])
    return [sorted(r, key=lambda l: l.cx) for r in rows]


def tokenize(lines: list[Line]) -> list[Token]:
    """Potongan angka (digit run) dalam urutan baca."""
    tokens: list[Token] = []
    for row_idx, row in enumerate(cluster_rows(lines)):
        for ln in row:
            for word in ln.text.split():
                for run in _DIGITS.findall(fix_confusables(word)):
                    tokens.append(Token(run, ln.confidence, row_idx))
    return tokens


def _make_candidate(tokens: list[Token], start: int, end: int, length: int,
                    check_luhn: bool) -> Candidate:
    chunk = tokens[start:end + 1]
    digits = "".join(t.digits for t in chunk)
    weight = sum(len(t.digits) for t in chunk)
    conf = sum(t.confidence * len(t.digits) for t in chunk) / weight
    length_ok = len(digits) == length
    luhn = luhn_valid(digits) if (check_luhn and length_ok) else None
    note = ""
    if not length_ok:
        note = f"{len(digits)} digit (seharusnya {length})"
    elif luhn is False:
        note = "Checksum Luhn tidak cocok"
    return Candidate(digits, conf, luhn, length_ok, chunk[0].row, start, end, note, chunk)


def _rank(c: Candidate) -> tuple:
    return (c.ok, c.luhn is True, c.confidence)


def find_card_numbers(lines: list[Line], length: int = 16, check_luhn: bool = True,
                      max_results: int = 5) -> list[Candidate]:
    """Cari nomor kartu sepanjang `length` digit dari hasil OCR.

    Bila tidak ada yang panjangnya pas, kembalikan baris yang panjangnya
    mendekati (selisih <= 3 digit) dengan catatan, supaya bisa dikoreksi manual.
    """
    tokens = tokenize(lines)
    exact: list[Candidate] = []
    for i in range(len(tokens)):
        total = 0
        for j in range(i, len(tokens)):
            if tokens[j].row != tokens[i].row:
                break
            total += len(tokens[j].digits)
            if total == length:
                exact.append(_make_candidate(tokens, i, j, length, check_luhn))
                break
            if total > length:
                break

    chosen = _select_non_overlapping(exact)
    if not chosen:
        chosen = _near_misses(tokens, length, check_luhn)
    chosen = chosen[:max_results]
    return sorted(chosen, key=lambda c: (c.row, c.start))


def _select_non_overlapping(cands: list[Candidate]) -> list[Candidate]:
    picked: list[Candidate] = []
    for c in sorted(cands, key=_rank, reverse=True):
        if all(c.end < p.start or c.start > p.end for p in picked):
            picked.append(c)
    return picked


def _near_misses(tokens: list[Token], length: int, check_luhn: bool) -> list[Candidate]:
    by_row: dict[int, list[int]] = {}
    for idx, t in enumerate(tokens):
        by_row.setdefault(t.row, []).append(idx)
    out = []
    for idxs in by_row.values():
        c = _make_candidate(tokens, idxs[0], idxs[-1], length, check_luhn)
        if 1 <= abs(len(c.digits) - length) <= 3:
            out.append(c)
    return sorted(out, key=lambda c: (abs(len(c.digits) - length), -c.confidence))


def find_numbers(lines: list[Line]) -> list[Candidate]:
    """Mode 'semua angka': setiap angka (desimal/ribuan/negatif) di teks OCR."""
    out: list[Candidate] = []
    for row_idx, row in enumerate(cluster_rows(lines)):
        for ln in row:
            for value in _NUMBER.findall(ln.text):
                out.append(Candidate(value, ln.confidence, None, True, row_idx,
                                     len(out), len(out), grouped=False))
    return out


def summarize(cands: list[Candidate]) -> tuple[int, float]:
    """Skor perbandingan antar-percobaan: (jumlah hasil valid, rata-rata confidence)."""
    good = [c for c in cands if c.ok]
    mean = sum(c.confidence for c in good) / len(good) if good else 0.0
    return len(good), mean
