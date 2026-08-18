This is a **v1 falsification experiment**, not a finished tool. The bet under test: *variance across cheap, independent lenses is a usable signal for where a human reviewer should spend attention.* Treat every run as evidence for or against that bet, and say so plainly in your final report — don't just present numbers as if the method is already proven.

## 1. Get the lay of the land

Run `diff-digestor` to get a stat summary and a truncated per-file diff sample:

```bash
diff-digestor
```

If there are no changed files, tell the user and stop — there's nothing to evaluate.

## 2. Identify chunks and normalize

Using the stat summary and samples, identify the logical chunks (functions/classes/methods) touched by this change. For any file where the truncated sample doesn't show enough to identify a chunk's boundaries — large files, or samples that cut off mid-function — fetch that file's full diff yourself before proceeding:

```bash
jj diff --git -- <file>   # or: git diff -- <file>
```

For every chunk you identify, compute `chunkId = "<filePath>::<name>@<startLine>"`. Build a normalized payload — an array of `{ chunkId, filePath, type, name, content }` — and write it to `/tmp/pr-chunks-normalized.json`. This is the exact payload every lens will see; no lens gets anything else (no repo access, no other chunks' scores, no your own commentary).

If the total payload is large (rough guideline: well over ~30 chunks or very large `content` fields), trim `content` per chunk to a reasonable size for the lenses and note in your final report that trimming occurred — don't silently truncate without flagging it.

## 3. Fan out tier-1 lenses (parallel)

Invoke these five subagents via your harness's delegation tool (`task` in opencode, `subagent` in pi) **in a single message, all in parallel** (they are independent — do not chain them):

- `review-lens-idiom`
- `review-lens-api`
- `review-lens-perf`
- `review-lens-security`
- `review-lens-empathy`

For each, the task prompt is identical except for which lens it is: give it the full normalized chunk JSON and say "Score every chunk in this payload per your lens's rubric. Output only the JSON object your instructions specify."

## 4. Self-noise control

Pick **one** of the five lenses (default to `review-lens-idiom` unless the user asked otherwise) and invoke it **again**, as a fresh independent delegation call with the identical prompt used in step 3. This is not a retry-on-failure — run it even if the first call succeeded. Label its output as the "duplicate run."

This step exists to answer one question: is cross-lens disagreement real signal, or is it just how noisy a single cheap model is on repeat? Don't skip it — without it the whole heat map is unfalsifiable.

## 5. Parse and align

Parse all six JSON outputs (5 lenses + 1 duplicate). For every `chunkId` that appears in the normalized payload, build a row with each lens's score and reason. If a lens's output is missing a `chunkId`, malformed JSON, or fails to parse, mark that cell `null` and note it — do not silently coerce it to 0.

## 6. Compute

For each chunk, across the **five distinct lenses** (excluding the duplicate):
- `mean` = average score
- `variance` = population variance of the five scores

Across **all chunks**, compute the self-noise floor:
- `selfNoise` = mean of `(duplicate_score - original_score)²` for the chosen lens, over every chunk

This `selfNoise` is a single scalar for the whole run — your noise-floor baseline.

## 7. Classify each chunk

- **Signal — Contested**: `variance > selfNoise` and `variance > 0`. Lenses genuinely disagree; the disagreement itself is the finding — say *why* they disagree, using the reasons.
- **Signal — Consensus Risk**: `mean >= 2` and `variance <= selfNoise`. Lenses agree this is risky; low variance here is a *feature*, not a null result.
- **Quiet**: `mean < 1` and `variance <= selfNoise`. Probably safe — but this is exactly where a false-negative would hide, so list these chunks explicitly (name + file only, no need for reasons) rather than omitting them.

If `selfNoise` turns out to be as large as or larger than the typical cross-lens variance, say this explicitly and up front: it means this run cannot distinguish signal from noise, and the numbers below should be read skeptically.

## 8. Render the report

Produce a markdown report with, in order:
1. **Headline verdict**: one sentence — did this run produce discriminating signal, or did scores cluster/noise dominate? State the `selfNoise` value.
2. **Contested chunks** table, sorted by variance descending: chunk, per-lens scores, mean, variance, and a synthesized one-line explanation of the disagreement (pull from the individual reasons, don't just concatenate them).
3. **Consensus risk chunks** table, sorted by mean descending.
4. **Quiet zone** — a plain list of chunk names/files only.
5. **Validation ask**: explicitly invite the user to check the Quiet Zone against their own knowledge of the change ("does anything you know was risky show up here?") and to sanity-check whether Contested chunks land on things they'd actually want flagged. This is the falsification step — don't skip it or bury it.

## 9. Save and hand back

Save the canonical per-chunk JSON (chunkId, all lens scores + reasons, mean, variance, classification, selfNoise) to a temp file via `mktemp -t review-heatmap-XXXXXX.json`. Print the file path, then print the full rendered report.
