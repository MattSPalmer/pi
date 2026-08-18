import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from ai_sessions.sync import discover_paths, partition_paths

from ai_sessions.db import Database
from ai_sessions.ids import validate_id
from ai_sessions.sync import load_sync_state
from ai_sessions.tree import build_tree


class SharedTests(unittest.TestCase):
    def test_database_retries_lock_contention(self):
        locked = subprocess.CompletedProcess([], 1, "", "database is locked")
        success = subprocess.CompletedProcess([], 0, "", "")
        with patch(
            "ai_sessions.db.subprocess.run", side_effect=[locked, success]
        ) as run:
            Database("test.duckdb").execute("SELECT 1")
        self.assertEqual(run.call_count, 2)

    def test_discover_paths_and_partition(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / "nested" / "session.jsonl"
            path.parent.mkdir()
            path.write_text("{}\\n")
            paths = discover_paths(str(root))
            self.assertEqual(paths, [path.resolve()])
            changed, skipped = partition_paths(
                paths,
                {str(path.resolve()): (path.stat().st_size, path.stat().st_mtime)},
            )
            self.assertEqual((changed, skipped), ([], 1))

    def test_load_sync_state_skips_invalid_rows(self):
        class FakeDatabase:
            def query_json(self, _sql):
                return [
                    {"source_path": "/ok", "source_size": 3, "source_mtime": 4.5},
                    {"source_path": "/bad", "source_size": None, "source_mtime": 4.5},
                ]

        self.assertEqual(load_sync_state(FakeDatabase()), {"/ok": (3, 4.5)})

    def test_validate_id(self):
        self.assertEqual(validate_id("pi:session_1"), "pi:session_1")
        with self.assertRaises(ValueError):
            validate_id("x' OR 1=1")

    def test_build_tree_and_branch(self):
        events = [
            {
                "event_id": "root",
                "parent_event_id": None,
                "sequence": 1,
                "raw_json": '{"type":"session"}',
            },
            {
                "event_id": "child",
                "parent_event_id": "root",
                "sequence": 2,
                "raw_json": '{"type":"message"}',
            },
            {
                "event_id": "other",
                "parent_event_id": "root",
                "sequence": 3,
                "raw_json": '{"type":"message"}',
            },
        ]
        tree = build_tree(events, [], [], [])
        self.assertEqual([node["event_id"] for node in tree], ["root"])
        self.assertEqual(
            [node["event_id"] for node in tree[0]["children"]], ["child", "other"]
        )
        branch = build_tree(events, [], [], [], "child")
        self.assertEqual(branch[0]["children"][0]["event_id"], "child")


if __name__ == "__main__":
    unittest.main()
