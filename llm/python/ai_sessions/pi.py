"""Pi session parsing and cleanup primitives."""

from __future__ import annotations

import datetime as dt
import json
import pathlib
import sys
from typing import Any

from ai_sessions.db import sql_quote

DEFAULT_ROOT = ""


def file_mtime(path: pathlib.Path) -> str:
    return dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).isoformat()


def timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        value = value / 1000
        return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat()
    return str(value).replace("Z", "+00:00")


def text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return "" if content is None else str(content)
    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") in ("text", "thinking"):
            if block.get("text"):
                parts.append(str(block["text"]))
        elif block.get("type") == "toolResult":
            parts.append(text_content(block.get("content")))
    return "\n".join(p for p in parts if p)


def event_id(session_id: str, value: Any, fallback: str) -> str:
    return f"pi:{session_id}:{value or fallback}"


def parse_session(path: pathlib.Path) -> dict[str, list[dict[str, Any]]]:
    events: list[dict[str, Any]] = []
    sessions: list[dict[str, Any]] = []
    messages: list[dict[str, Any]] = []
    calls: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    malformed = 0
    malformed_records: list[dict[str, Any]] = []
    sid = path.stem.rsplit("_", 1)[-1]
    first = True
    model = provider = None
    system_prompt = None
    timestamps: list[str] = []
    previous_timestamp: dt.datetime | None = None

    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.endswith("\n"):
                continue  # Pi may still be writing the final record.
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as exc:
                malformed += 1
                malformed_records.append(
                    {"source_path": str(path), "line": line_no, "error": str(exc)}
                )
                print(
                    f"{path}:{line_no}: skipping invalid JSON: {exc}", file=sys.stderr
                )
                continue
            if not isinstance(raw, dict):
                continue
            if first and raw.get("type") == "session":
                sid = str(raw.get("id") or sid)
                cwd = raw.get("cwd")
                started = timestamp(raw.get("timestamp"))
                sessions.append(
                    {
                        "session_id": f"pi:{sid}",
                        "source": "pi",
                        "source_path": str(path),
                        "cwd": cwd,
                        "started_at": started,
                        "ended_at": started,
                        "name": None,
                        "model": None,
                        "provider": None,
                        "system_prompt": None,
                        "source_mtime": None,
                        "source_size": path.stat().st_size,
                    }
                )
                first = False
            elif first:
                first = False
            typ = raw.get("type")
            rid = event_id(sid, raw.get("id"), f"line-{line_no}")
            parent = (
                event_id(sid, raw.get("parentId"), "") if raw.get("parentId") else None
            )
            when = timestamp(raw.get("timestamp"))
            current_timestamp = None
            if when:
                timestamps.append(when)
                try:
                    current_timestamp = dt.datetime.fromisoformat(when)
                except ValueError:
                    pass
            events.append(
                {
                    "event_id": rid,
                    "session_id": f"pi:{sid}",
                    "parent_event_id": parent,
                    "event_type": str(typ or "unknown"),
                    "sequence": line_no,
                    "timestamp": when,
                    "raw_json": json.dumps(raw, separators=(",", ":")),
                }
            )
            if typ == "model_change":
                provider, model = raw.get("provider"), raw.get("modelId")
            if typ != "message" or not isinstance(raw.get("message"), dict):
                continue
            message = raw["message"]
            mid = str(raw.get("id") or line_no)
            msg_time = timestamp(message.get("timestamp") or raw.get("timestamp"))
            role = message.get("role")
            content = message.get("content")
            usage = message.get("usage") or {}
            message_text = text_content(content)
            if role == "system":
                system_prompt = message_text
            duration_ms = None
            if role == "assistant" and current_timestamp and previous_timestamp:
                duration_ms = max(
                    0,
                    round(
                        (current_timestamp - previous_timestamp).total_seconds() * 1000
                    ),
                )
            messages.append(
                {
                    "message_id": f"pi:{sid}:{mid}",
                    "session_id": f"pi:{sid}",
                    "event_id": rid,
                    "parent_event_id": parent,
                    "role": role,
                    "content": message_text,
                    "thinking": (
                        text_content(
                            [
                                b
                                for b in content
                                if isinstance(b, dict) and b.get("type") == "thinking"
                            ]
                        )
                        if isinstance(content, list)
                        else None
                    ),
                    "model": message.get("model") or model,
                    "provider": message.get("provider") or provider,
                    "timestamp": msg_time,
                    "input_tokens": usage.get("input"),
                    "output_tokens": usage.get("output"),
                    "stop_reason": raw.get("stopReason"),
                    "duration_ms": duration_ms,
                    "token_details": (
                        json.dumps(usage, separators=(",", ":")) if usage else None
                    ),
                }
            )
            if role == "assistant" and isinstance(content, list):
                for index, block in enumerate(content):
                    if not isinstance(block, dict) or block.get("type") != "toolCall":
                        continue
                    call_id = str(block.get("id") or f"{mid}-{index}")
                    calls.append(
                        {
                            "tool_call_id": f"pi:{sid}:{call_id}",
                            "session_id": f"pi:{sid}",
                            "event_id": rid,
                            "parent_event_id": parent,
                            "tool_name": block.get("name"),
                            "arguments": json.dumps(
                                block.get("arguments", {}), separators=(",", ":")
                            ),
                            "timestamp": msg_time,
                        }
                    )
            if current_timestamp:
                previous_timestamp = current_timestamp
            if role == "toolResult":
                call_id = message.get("toolCallId")
                results.append(
                    {
                        "tool_result_id": f"pi:{sid}:{mid}",
                        "tool_call_id": f"pi:{sid}:{call_id}" if call_id else None,
                        "session_id": f"pi:{sid}",
                        "output": text_content(content),
                        "error": message.get("error"),
                        "timestamp": msg_time,
                    }
                )

    if not sessions:
        sessions.append(
            {
                "session_id": f"pi:{sid}",
                "source": "pi",
                "source_path": str(path),
                "cwd": None,
                "started_at": timestamps[0] if timestamps else None,
                "ended_at": timestamps[-1] if timestamps else None,
                "name": None,
                "model": model,
                "provider": provider,
                "source_mtime": None,
                "source_size": path.stat().st_size,
            }
        )
    sessions[0]["ended_at"] = (
        timestamps[-1] if timestamps else sessions[0]["started_at"]
    )
    sessions[0]["model"], sessions[0]["provider"] = model, provider
    sessions[0]["system_prompt"] = system_prompt
    return {
        "sessions": sessions,
        "events": events,
        "messages": messages,
        "calls": calls,
        "results": results,
        "malformed": malformed,
        "malformed_records": malformed_records,
    }


def cleanup_statements(paths: list[pathlib.Path]) -> list[str]:
    """SQL that removes Pi records whose source JSONL files are gone.

    DuckDB cannot delete a row that is still referenced by a foreign key when
    the referencing rows were deleted inside the *same* transaction: the FK
    index is only reconciled at commit time, so a single BEGIN/COMMIT block
    covering both the dependent rows and `sessions` always raises a constraint
    error. Cleanup therefore runs as two ordered transactions in one DuckDB
    invocation (DuckDB aborts the remaining statements on the first error).
    Dependent rows go first, so an interrupted cleanup can only ever leave
    parent rows behind - never orphans - and re-running finishes the job.

    An empty `paths` list is legitimate (the root contains no JSONL files at
    all), in which case every Pi session is missing. Legacy `source = 'llm'`
    sessions and any other source are never touched.
    """
    existing = ", ".join(sql_quote(str(p)) for p in paths)
    missing = f"source_path NOT IN ({existing})" if existing else "TRUE"
    doomed = f"SELECT session_id FROM sessions WHERE source='pi' AND {missing}"
    dependents = ["tool_results", "tool_calls", "messages", "attachments", "events"]
    return [
        "BEGIN TRANSACTION;",
        *(
            f"DELETE FROM {table} WHERE session_id IN ({doomed});"
            for table in dependents
        ),
        "COMMIT;",
        "BEGIN TRANSACTION;",
        f"DELETE FROM sync_state WHERE source_kind='pi' AND {missing};",
        f"DELETE FROM sessions WHERE source='pi' AND {missing};",
        "COMMIT;",
    ]
