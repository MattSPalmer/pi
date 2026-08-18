from __future__ import annotations
import json, os, pathlib, subprocess, time

DEFAULT_DB = os.path.expanduser(
    "~/Library/Application Support/ai-sessions/sessions.duckdb"
)


class Database:
    def __init__(self, path: str | pathlib.Path | None = None):
        self.path = str(path or os.environ.get("AI_SESSION_DB", DEFAULT_DB))

    def execute(self, sql: str, retries: int = 3) -> None:
        for attempt in range(retries):
            result = subprocess.run(
                ["duckdb", self.path, "-c", sql], capture_output=True, text=True
            )
            if result.returncode == 0:
                return
            if attempt + 1 == retries or "lock" not in result.stderr.lower():
                raise subprocess.CalledProcessError(
                    result.returncode, result.args, result.stdout, result.stderr
                )
            time.sleep(0.1 * (2**attempt))

    def query_json(self, sql: str, retries: int = 3) -> list[dict]:
        for attempt in range(retries):
            result = subprocess.run(
                ["duckdb", self.path, "-json", "-c", sql],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                return json.loads(result.stdout or "[]")
            if attempt + 1 == retries or "lock" not in result.stderr.lower():
                raise subprocess.CalledProcessError(
                    result.returncode, result.args, result.stdout, result.stderr
                )
            time.sleep(0.1 * (2**attempt))
        return []


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
