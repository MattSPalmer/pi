from __future__ import annotations
import json


def build_tree(events, messages, calls, results, branch=None):
    nodes = {}
    for row in events:
        row = dict(row)
        raw = row.pop("raw_json", None)
        try:
            row["raw"] = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            row["raw"] = None
        row.update(children=[], messages=[], tool_calls=[])
        nodes[row["event_id"]] = row
    for row in messages:
        if row.get("event_id") in nodes:
            nodes[row["event_id"]]["messages"].append(row)
    result_map = {}
    for row in results:
        result_map.setdefault(row.get("tool_call_id"), []).append(row)
    for row in calls:
        if row.get("event_id") in nodes:
            row = dict(row)
            row["results"] = result_map.get(row.get("tool_call_id"), [])
            nodes[row["event_id"]]["tool_calls"].append(row)
    if branch:
        keep = set()
        current = branch
        while current:
            if current not in nodes:
                raise ValueError("branch event not found")
            keep.add(current)
            current = nodes[current].get("parent_event_id")
        nodes = {key: value for key, value in nodes.items() if key in keep}
    roots = []
    for node in nodes.values():
        parent = node.get("parent_event_id")
        if parent in nodes:
            nodes[parent]["children"].append(node)
        else:
            roots.append(node)
    for node in nodes.values():
        node["children"].sort(key=lambda x: x.get("sequence") or 0)
    return roots
