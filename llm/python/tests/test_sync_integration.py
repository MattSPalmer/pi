import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parents[2]
SCHEMA = ROOT / "schema.sql"
FIXTURE = pathlib.Path(__file__).parent / "fixtures/tool-loop.jsonl"

COUNTS_SQL = """SELECT
  (SELECT count(*) FROM sessions WHERE source='pi') AS pi_sessions,
  (SELECT count(*) FROM sessions WHERE source='llm') AS llm_sessions,
  (SELECT count(*) FROM events) AS events,
  (SELECT count(*) FROM messages) AS messages,
  (SELECT count(*) FROM tool_calls) AS tool_calls,
  (SELECT count(*) FROM tool_results) AS tool_results,
  (SELECT count(*) FROM attachments) AS attachments,
  (SELECT count(*) FROM sync_state WHERE source_kind='pi') AS pi_sync_state,
  (SELECT count(*) FROM sync_runs WHERE source_kind='pi') AS pi_sync_runs"""


class SyncIntegrationTests(unittest.TestCase):
    def init_db(self, db):
        subprocess.run(
            ["duckdb", str(db)],
            input=SCHEMA.read_text(),
            text=True,
            check=True,
            capture_output=True,
        )

    def sync(self, sessions, db, *extra):
        env = {**os.environ, "PYTHONPATH": str(ROOT / "python")}
        command = [
            "python3",
            str(ROOT / "pi-session-sync.py"),
            "--root",
            str(sessions),
            "--db",
            str(db),
            *extra,
        ]
        result = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        return json.loads(result.stdout)

    def counts(self, db):
        result = subprocess.run(
            ["duckdb", str(db), "-json", "-c", COUNTS_SQL],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)[0]

    def insert_legacy(self, db):
        subprocess.run(
            [
                "duckdb",
                str(db),
                "-c",
                "INSERT INTO sessions (session_id, source, source_path) VALUES ('llm:legacy','llm','/legacy.db');"
                "INSERT INTO events VALUES ('llm:legacy:e1','llm:legacy',NULL,'message',1,NULL,'{}');"
                "INSERT INTO messages (message_id, session_id, event_id, role, content) "
                "VALUES ('llm:legacy:m1','llm:legacy','llm:legacy:e1','assistant','hi');"
                "INSERT INTO sync_state (source_path, source_kind) VALUES ('/legacy.db','llm');",
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    def test_compatibility_view_preserves_tools_and_thinking(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sessions = tmp / "sessions"
            sessions.mkdir()
            shutil.copy(FIXTURE, sessions / "session_fixture-1.jsonl")
            db = tmp / "sessions.duckdb"
            self.init_db(db)
            self.sync(sessions, db)
            result = subprocess.run(
                [
                    "duckdb",
                    str(db),
                    "-json",
                    "-c",
                    "SELECT * FROM conversation_responses WHERE conversation_id='pi:fixture-1'",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            rows = json.loads(result.stdout)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["thinking"], "Need a tool")
            tools = rows[0]["tool_calls"]
            if isinstance(tools, str):
                tools = json.loads(tools)
            self.assertEqual(tools[0]["name"], "lookup")

    def test_session_json_exports_tree_and_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sessions = tmp / "sessions"
            sessions.mkdir()
            shutil.copy(FIXTURE, sessions / "session_fixture-1.jsonl")
            db = tmp / "sessions.duckdb"
            self.init_db(db)
            env = {**os.environ, "PYTHONPATH": str(ROOT / "python")}
            self.sync(sessions, db)
            command = [
                "python3",
                str(ROOT / "session-json.py"),
                "pi:fixture-1",
                "--db",
                str(db),
            ]
            output = json.loads(
                subprocess.run(
                    command, env=env, check=True, capture_output=True, text=True
                ).stdout
            )
            self.assertEqual(output["schema_version"], 1)
            self.assertEqual(output["session"]["session_id"], "pi:fixture-1")
            self.assertEqual(output["events"][0]["event_id"], "pi:fixture-1:fixture-1")
            branch = json.loads(
                subprocess.run(
                    command + ["--branch", "pi:fixture-1:a1"],
                    env=env,
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout
            )
            self.assertEqual(
                branch["events"][0]["children"][0]["children"][0]["event_id"],
                "pi:fixture-1:a1",
            )

    def test_full_rebuild_reparses_without_duplicates(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sessions = tmp / "sessions"
            sessions.mkdir()
            shutil.copy(FIXTURE, sessions / "session_fixture-1.jsonl")
            db = tmp / "sessions.duckdb"
            self.init_db(db)
            self.sync(sessions, db)
            result = self.sync(sessions, db, "--full")
            self.assertEqual(result["parsed"], 1)
            counts = self.counts(db)
            self.assertEqual(counts["pi_sessions"], 1)
            self.assertEqual(counts["events"], 4)
            self.assertEqual(counts["messages"], 3)
            self.assertEqual(counts["pi_sync_runs"], 2)

    def test_repeated_sync_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sessions = tmp / "sessions"
            sessions.mkdir()
            shutil.copy(FIXTURE, sessions / "session_fixture-1.jsonl")
            db = tmp / "sessions.duckdb"
            self.init_db(db)
            first = self.sync(sessions, db)
            second = self.sync(sessions, db)
            self.assertEqual(first["parsed"], 1)
            self.assertEqual(second["parsed"], 0)
            self.assertEqual(second["skipped"], 1)
            self.assertEqual(self.counts(db)["events"], 4)

    def test_cleanup_removes_sessions_whose_source_file_is_gone(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sessions = tmp / "sessions"
            sessions.mkdir()
            source = sessions / "session_fixture-1.jsonl"
            shutil.copy(FIXTURE, source)
            db = tmp / "sessions.duckdb"
            self.init_db(db)
            self.sync(sessions, db)
            self.insert_legacy(db)
            subprocess.run(
                [
                    "duckdb",
                    str(db),
                    "-c",
                    "INSERT INTO attachments (attachment_id, session_id) "
                    "SELECT 'pi:a1', session_id FROM sessions WHERE source='pi';",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            before = self.counts(db)
            self.assertEqual(before["pi_sessions"], 1)
            self.assertEqual(before["tool_calls"], 1)
            self.assertEqual(before["tool_results"], 1)
            self.assertEqual(before["attachments"], 1)
            self.assertEqual(before["pi_sync_state"], 1)

            source.unlink()
            self.sync(sessions, db, "--cleanup")

            after = self.counts(db)
            self.assertEqual(after["pi_sessions"], 0)
            self.assertEqual(after["tool_calls"], 0)
            self.assertEqual(after["tool_results"], 0)
            self.assertEqual(after["attachments"], 0)
            self.assertEqual(after["pi_sync_state"], 0)
            # Legacy rows are untouched.
            self.assertEqual(after["llm_sessions"], 1)
            self.assertEqual(after["events"], 1)
            self.assertEqual(after["messages"], 1)

    def test_cleanup_keeps_sessions_whose_source_file_remains(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sessions = tmp / "sessions"
            sessions.mkdir()
            shutil.copy(FIXTURE, sessions / "session_fixture-1.jsonl")
            db = tmp / "sessions.duckdb"
            self.init_db(db)
            self.sync(sessions, db)
            self.sync(sessions, db, "--cleanup")
            after = self.counts(db)
            self.assertEqual(after["pi_sessions"], 1)
            self.assertEqual(after["events"], 4)
            self.assertEqual(after["pi_sync_state"], 1)

    def test_cleanup_with_empty_root_from_the_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            sessions = tmp / "sessions"
            sessions.mkdir()
            db = tmp / "sessions.duckdb"
            self.init_db(db)
            self.insert_legacy(db)
            result = self.sync(sessions, db, "--cleanup")
            self.assertEqual(result["files"], 0)
            self.assertEqual(result["parsed"], 0)
            after = self.counts(db)
            self.assertEqual(after["pi_sessions"], 0)
            self.assertEqual(after["llm_sessions"], 1)
            self.assertEqual(after["events"], 1)

    def test_cleanup_rejects_session_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            db = tmp / "sessions.duckdb"
            self.init_db(db)
            env = {**os.environ, "PYTHONPATH": str(ROOT / "python")}
            result = subprocess.run(
                [
                    "python3",
                    str(ROOT / "pi-session-sync.py"),
                    "--db",
                    str(db),
                    "--cleanup",
                    "--session",
                    str(FIXTURE),
                ],
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("cannot be combined", result.stderr)


if __name__ == "__main__":
    unittest.main()
