import pathlib
import unittest


class SearchQueryTests(unittest.TestCase):
    def test_search_projection_includes_rich_fields(self):
        query = (pathlib.Path(__file__).parents[2] / "query.nix").read_text()
        for field in (
            "m.thinking",
            "tc.arguments",
            "tr.output",
            "tr.error",
            "'snippet'",
        ):
            self.assertIn(field, query)


if __name__ == "__main__":
    unittest.main()
