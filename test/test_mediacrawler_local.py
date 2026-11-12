import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mediacrawler_local", ROOT / "scripts/mediacrawler-local.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class CollectorBoundaryTests(unittest.TestCase):
    def test_sample_cap_applies_before_detail_fetch_without_mutating_response(self):
        items = [{"id": str(i), "model_type": "note"} for i in range(20)]
        response = {"items": items, "has_more": True}
        result = runner.bounded_items(response, 5)
        self.assertEqual(len(result["items"]), 5)
        self.assertEqual(len(response["items"]), 20)
        self.assertTrue(result["has_more"])

    def test_recommendation_queries_are_not_counted_as_posts(self):
        response = {"items": [{"model_type": "rec_query"}, None, {"id": "a"}, {"model_type": "hot_query"}, {"id": "b"}]}
        self.assertEqual([r["id"] for r in runner.bounded_items(response, 2)["items"]], ["a", "b"])
        for limit in [0, 6, -1]:
            with self.assertRaisesRegex(ValueError, "INVALID_SAMPLE_LIMIT"):
                runner.bounded_items(response, limit)

    def test_output_path_cannot_escape_private_workspace(self):
        self.assertEqual(runner.private_path(str(ROOT / ".local-data/runs/sample")), ROOT / ".local-data/runs/sample")
        for path in [ROOT / "docs/raw.json", ROOT / ".local-data/../leak.json", ROOT.parent / "outside.json"]:
            with self.assertRaisesRegex(ValueError, "PATH_MUST_BE_PRIVATE"):
                runner.private_path(str(path))

    def test_only_xiaohongshu_is_enabled(self):
        self.assertEqual(set(runner.PLATFORMS), {"xhs"})

    def test_platform_response_caps_and_unrecognized_errors(self):
        for platform, key in [("dy", "data"), ("ks", "feeds"), ("bili", "result")]:
            response = {key: list(range(20))}
            result, count = runner.bound_response(platform, response, 5)
            self.assertEqual(count, 20)
            self.assertEqual(len(result[key]), 5)
            self.assertEqual(len(response[key]), 20)
        self.assertEqual(runner.bound_response("tieba", list(range(20)), 5), (list(range(5)), 20))
        for platform in runner.PLATFORMS:
            with self.assertRaisesRegex(ValueError, "UNRECOGNIZED_SEARCH_RESPONSE"):
                runner.bound_response(platform, None, 5)


if __name__ == "__main__":
    unittest.main()
