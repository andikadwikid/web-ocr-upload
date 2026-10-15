import unittest

from ocr.cardnum import (
    Line,
    cluster_rows,
    find_card_numbers,
    find_numbers,
    fix_confusables,
    group_digits,
    luhn_valid,
    summarize,
)

CARD = "6032981234567899"  # lolos Luhn


def line(text, x=0, y=0, conf=90, h=40):
    return Line(text, conf, cx=x, cy=y, height=h)


class LuhnTest(unittest.TestCase):
    def test_valid_and_invalid(self):
        self.assertTrue(luhn_valid(CARD))
        self.assertFalse(luhn_valid("6032981234567890"))  # satu digit salah
        self.assertFalse(luhn_valid(""))
        self.assertFalse(luhn_valid("60a2"))

    def test_every_single_digit_error_is_detected(self):
        for pos in range(16):
            for d in "0123456789":
                if d != CARD[pos]:
                    self.assertFalse(luhn_valid(CARD[:pos] + d + CARD[pos + 1:]), (pos, d))


class FormatTest(unittest.TestCase):
    def test_group_digits(self):
        self.assertEqual(group_digits(CARD), "6032 9812 3456 7899")
        self.assertEqual(group_digits("12345"), "1234 5")

    def test_fix_confusables_only_in_mostly_digit_words(self):
        self.assertEqual(fix_confusables("l234"), "1234")
        self.assertEqual(fix_confusables("S032"), "5032")
        self.assertEqual(fix_confusables("9O0O"), "9000")
        self.assertEqual(fix_confusables("TOKO"), "TOKO")  # tanpa angka: dibiarkan
        self.assertEqual(fix_confusables("B2"), "B2")  # hanya 1 digit: dibiarkan
        self.assertEqual(fix_confusables("A1BC"), "A1BC")  # <50% angka: dibiarkan


class CardNumberTest(unittest.TestCase):
    def test_single_line_with_spaces(self):
        (c,) = find_card_numbers([line("6032 9812 3456 7899")])
        self.assertEqual(c.digits, CARD)
        self.assertTrue(c.length_ok and c.luhn is True and c.ok)

    def test_ocr_dropped_some_spaces(self):  # hasil nyata RapidOCR pada foto contoh
        (c,) = find_card_numbers([line("603298123456 7899", conf=84.9)])
        self.assertEqual(c.digits, CARD)
        self.assertAlmostEqual(c.confidence, 84.9)

    def test_split_into_boxes_is_merged_left_to_right(self):
        lines = [line("3456 7899", x=700, y=100), line("6032 9812", x=300, y=104)]
        (c,) = find_card_numbers(lines)
        self.assertEqual(c.digits, CARD)

    def test_ignores_other_text_and_rows(self):
        lines = [
            line("MANDIRI e-money", x=200, y=40),
            line("6032 9812", x=300, y=300),
            line("3456 7899", x=700, y=300),
            line("Berlaku s/d 12/29", x=300, y=420),
        ]
        (c,) = find_card_numbers(lines)
        self.assertEqual(c.digits, CARD)

    def test_confusable_letters_are_repaired(self):
        (c,) = find_card_numbers([line("6O32 98l2 3456 7899")])
        self.assertEqual(c.digits, CARD)
        self.assertTrue(c.luhn)

    def test_luhn_failure_is_reported_not_hidden(self):
        (c,) = find_card_numbers([line("6032 9812 3456 7890")])
        self.assertTrue(c.length_ok)
        self.assertIs(c.luhn, False)
        self.assertFalse(c.ok)
        self.assertIn("Luhn", c.note)

    def test_luhn_can_be_disabled(self):
        (c,) = find_card_numbers([line("6032 9812 3456 7890")], check_luhn=False)
        self.assertIsNone(c.luhn)
        self.assertTrue(c.ok)

    def test_valid_candidate_beats_invalid_overlapping_one(self):
        # 17 digit di satu baris: jendela 16 digit yang lolos Luhn harus menang.
        lines = [line("6032 9812 3456 7899"), line("5", x=900)]
        cands = find_card_numbers(lines)
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0].digits, CARD)

    def test_two_cards_in_one_photo_keep_reading_order(self):
        other = "4539578763621486"  # lolos Luhn
        lines = [line(group := " ".join(other[i:i + 4] for i in range(0, 16, 4)), y=500),
                 line("6032 9812 3456 7899", y=100)]
        got = [c.digits for c in find_card_numbers(lines)]
        self.assertEqual(got, [CARD, other])

    def test_wrong_length_returns_near_miss_with_note(self):
        (c,) = find_card_numbers([line("6032 9812 3456 789")])  # 15 digit
        self.assertFalse(c.length_ok)
        self.assertFalse(c.ok)
        self.assertIn("15 digit", c.note)
        self.assertEqual(c.digits, "603298123456789")

    def test_nothing_numeric(self):
        self.assertEqual(find_card_numbers([line("MANDIRI e-money")]), [])
        self.assertEqual(find_card_numbers([]), [])

    def test_custom_length(self):
        (c,) = find_card_numbers([line("1234 5678")], length=8, check_luhn=False)
        self.assertEqual(c.digits, "12345678")


class AnyNumbersTest(unittest.TestCase):
    def test_all_numbers_not_grouped(self):
        got = find_numbers([line("Total 65.000 dan 3,5", y=10), line("Kembali 35.000", y=90)])
        self.assertEqual([c.to_dict()["value"] for c in got], ["65.000", "3,5", "35.000"])


class MiscTest(unittest.TestCase):
    def test_cluster_rows_tolerance(self):
        rows = cluster_rows([line("a", x=1, y=100), line("b", x=2, y=110), line("c", x=3, y=400)])
        self.assertEqual([[l.text for l in r] for r in rows], [["a", "b"], ["c"]])

    def test_summarize(self):
        good = find_card_numbers([line("6032 9812 3456 7899", conf=80)])
        bad = find_card_numbers([line("6032 9812 3456 7890", conf=99)])
        self.assertEqual(summarize(good), (1, 80.0))
        self.assertEqual(summarize(bad), (0, 0.0))


if __name__ == "__main__":
    unittest.main()
