#!/usr/bin/env python3
"""Export a complete AI session event tree from DuckDB."""
import argparse
import json
import os
import subprocess
import sys
from ai_sessions.db import Database, sql_quote
from ai_sessions.ids import validate_id
from ai_sessions.tree import build_tree


def query(db: str, sql: str):
    return Database(db).query_json(sql)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export a complete AI session event tree"
    )
    parser.add_argument("session_id")
    parser.add_argument(
        "--branch", help="export only the path from the selected event to its root"
    )
    parser.add_argument(
        "--db",
        default=os.environ.get(
            "AI_SESSION_DB",
            os.path.expanduser(
                "~/Library/Application Support/ai-sessions/sessions.duckdb"
            ),
        ),
    )
    args = parser.parse_args()
    try:
        validate_id(args.session_id, "session id")
    except ValueError as exc:
        parser.error(str(exc))

    sid = sql_quote(args.session_id)
    session = query(args.db, f"SELECT * FROM sessions WHERE session_id={sid}")
    if not session:
        print(f"session-json: session not found: {args.session_id}", file=sys.stderr)
        return 1
    events = query(
        args.db,
        f"SELECT event_id, session_id, parent_event_id, event_type, sequence, timestamp, raw_json FROM events WHERE session_id={sid} ORDER BY sequence",
    )
    messages = query(
        args.db,
        f"SELECT * FROM messages WHERE session_id={sid} ORDER BY timestamp, message_id",
    )
    calls = query(
        args.db,
        f"SELECT * FROM tool_calls WHERE session_id={sid} ORDER BY timestamp, tool_call_id",
    )
    results = query(
        args.db,
        f"SELECT * FROM tool_results WHERE session_id={sid} ORDER BY timestamp, tool_result_id",
    )

    try:
        roots = build_tree(events, messages, calls, results, args.branch)
    except ValueError as exc:
        parser.error(str(exc))

    output = {"schema_version": 1, "session": session[0], "events": roots}
    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
