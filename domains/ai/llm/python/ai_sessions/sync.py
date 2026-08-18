"""Shared synchronization bookkeeping helpers."""

import glob
import os
import json
import pathlib
import tempfile
from collections.abc import Iterable
from typing import Any

from .db import Database, sql_quote

ENTITY_KEYS = ("sessions", "events", "messages", "calls", "results")


def discover_paths(
    root: str, session: pathlib.Path | None = None
) -> list[pathlib.Path]:
    """Discover normalized JSONL session paths for a sync invocation."""
    paths = (
        [session]
        if session
        else [
            pathlib.Path(path)
            for path in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)
        ]
    )
    return sorted(
        {pathlib.Path(os.path.realpath(path)) for path in paths if path.is_file()}
    )


def write_batches(
    db: Database,
    batches: list[dict[str, list[dict[str, Any]]]],
    paths: list[pathlib.Path],
) -> dict[str, int]:
    """Atomically write parsed Pi batches and update their fingerprints."""
    from .pi import file_mtime

    counts = summarize_batches(batches)
    with tempfile.TemporaryDirectory(prefix="pi-session-sync-") as directory:
        files = {}
        for key in ENTITY_KEYS:
            filename = pathlib.Path(directory) / f"{key}.json"
            filename.write_text(
                json.dumps([row for batch in batches for row in batch[key]]),
                encoding="utf-8",
            )
            files[key] = sql_quote(str(filename))
        statements = ["BEGIN TRANSACTION;"]
        if counts["sessions"]:
            statements.append(
                f"INSERT INTO sessions (session_id, source, source_path, cwd, started_at, ended_at, name, model, provider, system_prompt, source_mtime, source_size) SELECT session_id, source, source_path, cwd, try_cast(started_at AS TIMESTAMP), try_cast(ended_at AS TIMESTAMP), name, model, provider, system_prompt, try_cast(source_mtime AS TIMESTAMP), source_size FROM read_json_auto({files['sessions']}) ON CONFLICT (session_id) DO UPDATE SET source_path=excluded.source_path, cwd=excluded.cwd, started_at=excluded.started_at, ended_at=excluded.ended_at, model=excluded.model, provider=excluded.provider, system_prompt=excluded.system_prompt, source_size=excluded.source_size, imported_at=now();"
            )
        if counts["events"]:
            statements.append(
                f"INSERT INTO events SELECT event_id, session_id, parent_event_id, event_type, sequence, try_cast(timestamp AS TIMESTAMP), try_cast(raw_json AS JSON) FROM read_json_auto({files['events']}) ON CONFLICT (event_id) DO UPDATE SET parent_event_id=excluded.parent_event_id, event_type=excluded.event_type, sequence=excluded.sequence, timestamp=excluded.timestamp, raw_json=excluded.raw_json;"
            )
        if counts["messages"]:
            statements.append(
                f"INSERT INTO messages SELECT message_id, session_id, event_id, parent_event_id, role, content, thinking, model, provider, try_cast(timestamp AS TIMESTAMP), input_tokens, output_tokens, stop_reason, duration_ms, try_cast(token_details AS JSON) FROM read_json_auto({files['messages']}) ON CONFLICT (message_id) DO UPDATE SET content=excluded.content, thinking=excluded.thinking, model=excluded.model, provider=excluded.provider, timestamp=excluded.timestamp, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, stop_reason=excluded.stop_reason, duration_ms=excluded.duration_ms, token_details=excluded.token_details;"
            )
        if counts["calls"]:
            statements.append(
                f"INSERT INTO tool_calls SELECT tool_call_id, session_id, event_id, parent_event_id, tool_name, try_cast(arguments AS JSON), try_cast(timestamp AS TIMESTAMP) FROM read_json_auto({files['calls']}) ON CONFLICT (tool_call_id) DO UPDATE SET tool_name=excluded.tool_name, arguments=excluded.arguments, timestamp=excluded.timestamp;"
            )
        if counts["results"]:
            statements.append(
                f"INSERT INTO tool_results SELECT tool_result_id, tool_call_id, session_id, output, error, try_cast(timestamp AS TIMESTAMP) FROM read_json_auto({files['results']}) ON CONFLICT (tool_result_id) DO UPDATE SET output=excluded.output, error=excluded.error, timestamp=excluded.timestamp;"
            )
        for path in paths:
            q = sql_quote(str(path))
            statements.append(
                f"INSERT INTO sync_state (source_path, source_kind, source_size, source_mtime, last_line, synced_at) VALUES ({q}, 'pi', {path.stat().st_size}, try_cast({sql_quote(file_mtime(path))} AS TIMESTAMP), (SELECT max(sequence) FROM events WHERE session_id=(SELECT session_id FROM sessions WHERE source_path={q} LIMIT 1)), now()) ON CONFLICT (source_path) DO UPDATE SET source_size=excluded.source_size, source_mtime=excluded.source_mtime, last_line=excluded.last_line, synced_at=excluded.synced_at;"
            )
        statements.append("COMMIT;")
        db.execute("\n".join(statements))
    return counts


def record_sync_run(
    db: Database,
    root: str,
    files: int,
    parsed: int,
    skipped: int,
    malformed: int,
    cleanup: bool,
    status: str,
    error: str | None = None,
    malformed_details: list[dict[str, Any]] | None = None,
    duration_ms: int | None = None,
) -> None:
    """Persist one synchronization outcome."""
    error_sql = "NULL" if error is None else sql_quote(error[:4000])
    db.execute(
        "INSERT INTO sync_runs (source_kind, root_path, started_at, finished_at, "
        "files_seen, files_parsed, files_skipped, malformed, malformed_details, "
        "duration_ms, cleanup, status, error) "
        f"VALUES ({sql_quote('pi')}, {sql_quote(root)}, now(), now(), {files}, {parsed}, {skipped}, "
        f"{malformed}, {sql_quote(json.dumps(malformed_details)) if malformed_details else 'NULL'}, "
        f"{duration_ms if duration_ms is not None else 0}, {str(cleanup).lower()}, {sql_quote(status)}, {error_sql})"
    )


def partition_paths(
    paths: Iterable[pathlib.Path],
    known: dict[str, tuple[int, float]],
    full: bool = False,
) -> tuple[list[pathlib.Path], int]:
    """Split files into changed and unchanged paths using size/mtime fingerprints."""
    changed: list[pathlib.Path] = []
    paths = list(paths)
    for path in paths:
        state = known.get(str(path))
        unchanged = bool(state and state[0] == path.stat().st_size)
        if unchanged and not full:
            try:
                unchanged = int(state[1]) == int(path.stat().st_mtime)
            except (TypeError, ValueError):
                pass
        if full or not unchanged:
            changed.append(path)
    return changed, len(paths) - len(changed)


def load_sync_state(db: Database) -> dict[str, tuple[int, float]]:
    """Load file fingerprints used for conservative incremental sync."""
    state: dict[str, tuple[int, float]] = {}
    for row in db.query_json(
        "SELECT source_path, source_size, epoch(source_mtime) AS source_mtime "
        "FROM sync_state"
    ):
        try:
            state[row["source_path"]] = (
                int(row["source_size"]),
                float(row["source_mtime"]),
            )
        except (KeyError, TypeError, ValueError):
            continue
    return state


def summarize_batches(
    batches: Iterable[dict[str, list[dict[str, Any]]]],
) -> dict[str, int]:
    """Return stable row and malformed-record counts for parsed sources."""
    batches = list(batches)
    counts = {
        key: sum(len(batch.get(key, [])) for batch in batches) for key in ENTITY_KEYS
    }
    counts["malformed"] = sum(batch.get("malformed", 0) for batch in batches)
    counts["malformed_records"] = [
        record for batch in batches for record in batch.get("malformed_records", [])
    ]
    return counts
