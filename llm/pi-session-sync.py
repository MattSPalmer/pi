#!/usr/bin/env python3
"""Import Pi JSONL session trees into the canonical DuckDB database."""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time

from ai_sessions.db import Database, sql_quote
from ai_sessions.pi import cleanup_statements, file_mtime, parse_session
from ai_sessions.sync import (
    discover_paths,
    load_sync_state,
    partition_paths,
    record_sync_run,
    summarize_batches,
    write_batches,
)

DEFAULT_ROOT = os.path.expanduser("~/.pi/agent/sessions")
DEFAULT_DB = os.path.expanduser(
    "~/Library/Application Support/ai-sessions/sessions.duckdb"
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        default=os.environ.get(
            "PI_CODING_AGENT_SESSION_DIR",
            os.environ.get("PI_SESSION_ROOT", DEFAULT_ROOT),
        ),
    )
    parser.add_argument("--session", type=pathlib.Path)
    parser.add_argument(
        "--full",
        action="store_true",
        help="ignore sync_state and reparse every discovered file",
    )
    parser.add_argument(
        "--cleanup",
        action="store_true",
        help="remove sessions whose source files are no longer present",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--db", default=os.environ.get("AI_SESSION_DB", DEFAULT_DB))
    args = parser.parse_args()
    started = time.monotonic()
    paths = discover_paths(args.root, args.session)
    if args.cleanup and args.session:
        parser.error(
            "--cleanup cannot be combined with --session; cleanup scopes the configured root"
        )

    # Read the bookkeeping table through DuckDB itself so this script does not
    # need a Python DuckDB dependency. A changed file is reparsed from the
    # beginning; this is deliberately conservative until append-only tail
    # parsing has stronger guarantees around interrupted final records.
    known: dict[str, tuple[int, float]] = {}
    if not args.full and pathlib.Path(args.db).exists():
        try:
            known = load_sync_state(Database(args.db))
        except (ValueError, TypeError, json.JSONDecodeError):
            print("pi-session-sync: ignoring unreadable sync_state", file=sys.stderr)

    changed_paths, skipped = partition_paths(paths, known, args.full)
    if not paths and not args.cleanup:
        record_sync_run(Database(args.db), str(args.root), 0, 0, 0, 0, False, "noop")
        print("pi-session-sync: no session files found", file=sys.stderr)
        return 0
    if not changed_paths and not args.cleanup:
        record_sync_run(
            Database(args.db), str(args.root), len(paths), 0, skipped, 0, False, "noop"
        )
        print(
            json.dumps(
                {
                    "files": len(paths),
                    "parsed": 0,
                    "skipped": skipped,
                    **{
                        key: 0
                        for key in (
                            "sessions",
                            "events",
                            "messages",
                            "calls",
                            "results",
                        )
                    },
                }
            )
        )
        return 0
    batches = [parse_session(p) for p in changed_paths]
    counts = summarize_batches(batches)
    if args.dry_run:
        record_sync_run(
            Database(args.db),
            str(args.root),
            len(paths),
            len(changed_paths),
            skipped,
            counts.get("malformed", 0),
            args.cleanup,
            "dry_run",
        )
        print(json.dumps({"files": len(paths), **counts}))
        return 0

    try:
        counts = write_batches(Database(args.db), batches, changed_paths)
        if args.cleanup:
            Database(args.db).execute("\n".join(cleanup_statements(paths)))
    except Exception as exc:
        try:
            record_sync_run(
                Database(args.db),
                str(args.root),
                len(paths),
                len(changed_paths),
                skipped,
                counts.get("malformed", 0),
                args.cleanup,
                "failed",
                str(exc),
                counts.get("malformed_records"),
                round((time.monotonic() - started) * 1000),
            )
        except Exception as record_error:
            print(
                f"pi-session-sync: unable to record failed run: {record_error}",
                file=sys.stderr,
            )
        raise
    record_sync_run(
        Database(args.db),
        str(args.root),
        len(paths),
        len(changed_paths),
        skipped,
        counts.get("malformed", 0),
        args.cleanup,
        "success",
        malformed_details=counts.get("malformed_records"),
        duration_ms=round((time.monotonic() - started) * 1000),
    )
    print(
        json.dumps(
            {
                "files": len(paths),
                "parsed": len(changed_paths),
                "skipped": skipped,
                **counts,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
