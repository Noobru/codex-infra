import unittest


def normalize_labels(values):
    return list(dict.fromkeys(value.strip().casefold() for value in values if value.strip()))


class TransformTests(unittest.TestCase):
    def test_normalizes_and_deduplicates_without_reordering(self):
        self.assertEqual(normalize_labels([" Beta ", "ALFA", "beta", "", "  "]), ["beta", "alfa"])

    def test_empty_input(self):
        self.assertEqual(normalize_labels([]), [])


if __name__ == "__main__":
    unittest.main()
