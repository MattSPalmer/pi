#!/usr/bin/env python3
"""Create a cost/word/time report from Pi JSONL sessions (Polars edition)."""
import json, os, pathlib, re, sys
from datetime import datetime
import polars as pl

WORD = re.compile(r"\b[\w]+(?:['’.-][\w]+)*\b")
root = pathlib.Path.home() / ".pi" / "agent" / "sessions"
workspace = next(
    (
        p
        for p in root.iterdir()
        if p.name == f"--{os.getcwd().strip('/').replace('/', '-') }--"
    ),
    None,
)
if workspace is None:
    # Pi's directory name is based on the absolute cwd; tolerate a missing
    # directory and make the error actionable rather than silently reporting 0.
    raise SystemExit(f"No Pi session directory found for {os.getcwd()}")
prefixes = sys.argv[1:]
paths = (
    sorted(workspace.glob("*.jsonl"))
    if not prefixes
    else [p for x in prefixes for p in workspace.glob(f"{x}*.jsonl")]
)
rows = []
for path in paths:
    with path.open() as stream:
        for line in stream:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            m, mid = r.get("message", {}), r.get("id")
            if mid and m:
                rows.append({"id": mid, "timestamp": r.get("timestamp"), "message": m})
if not rows:
    raise SystemExit("No matching JSONL sessions found")
df = pl.DataFrame(rows).unique("id", keep="last")
# Keeping message structs in Polars makes the deduplication and aggregation
# explicit while accommodating Pi's evolving message schema.
messages = df.get_column("message").to_list()
cost_rows = []
user_words = 0
for m in messages:
    if m.get("role") == "assistant":
        usage, cost = m.get("usage") or {}, (m.get("usage") or {}).get("cost") or {}
        cost_rows.append(
            {"model": m.get("model", "unknown"), "cost": cost.get("total", 0) or 0}
        )
    elif m.get("role") == "user":
        content = m.get("content", [])
        text = (
            "\n".join(
                x.get("text", "")
                for x in content
                if isinstance(x, dict) and x.get("type") == "text"
            )
            if isinstance(content, list)
            else str(content)
        )
        user_words += len(WORD.findall(text))
costs = (
    pl.DataFrame(cost_rows) if cost_rows else pl.DataFrame({"model": [], "cost": []})
)
summary = (
    costs.group_by("model")
    .agg(pl.len().alias("responses"), pl.col("cost").sum())
    .sort("model")
)
lines = [
    "# Pi session report",
    "",
    f"Sessions: {len(paths)} (unique messages: {df.height})",
    f"User messages: {sum(m.get('role') == 'user' for m in messages)}",
    f"User words: {user_words}",
    "",
    "| Model | Responses | Cost |",
    "|---|---:|---:|",
]
for row in summary.iter_rows(named=True):
    lines.append(f"| {row['model']} | {row['responses']} | ${row['cost']:.4f} |")
lines += [
    "",
    f"**Total cost: ${costs.get_column('cost').sum() if costs.height else 0:.4f}**",
    "",
    "Generated from read-only JSONL logs; fork replays are deduplicated by message id.",
]
print("\n".join(lines) + "\n")
