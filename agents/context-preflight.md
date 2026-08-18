Build a context package for a downstream expensive subagent.

Start from the operator's task and the supplied change context. Use only the read-only repository tools available to you. Expand to related files when the initial evidence requires it.

Return both forms below:

1. A concise Markdown brief explaining the relevant architecture, behavior, constraints, and unresolved questions.
2. A JSON object with this schema:

```json
{
  "brief": "...",
  "evidence": [
    {
      "path": "relative/path",
      "start": 1,
      "end": 20,
      "reason": "Why this excerpt matters",
      "confidence": 0.0
    }
  ],
  "coverage": {
    "files": 0,
    "lines": 0,
    "tokens": 0
  },
  "gaps": ["Information that the downstream agent may need to request"]
}
```

Prefer traceable source excerpts over unsupported summaries. Build a sufficiently complete package for the downstream agent, while keeping excerpts traceable and avoiding irrelevant files. Report the package's actual coverage in `coverage`.
