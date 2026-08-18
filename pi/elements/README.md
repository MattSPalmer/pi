# Ephemeral UI elements (pi extension)

Installed to `~/.pi/agent/extensions/elements/` by the flake.
Source of truth: `pi/elements/`.

## What it does

Registers one tool, `element`, that lets the agent offer the user a structured
choice as an interactive overlay instead of asking in prose. The offer and the
answer both land in the transcript.

## Data model

| Concept | Where it lives | Mutable? |
| --- | --- | --- |
| Element (the offer) | tool-call arguments | no |
| Outcome (what happened) | tool result `details.outcome` | no |
| Reference between them | `toolCallId` | — |

Elements are immutable; an outcome is a separate record that points at its
element. The pi v3 session tree is the only log — there is no parallel event
stream to reconcile.

Prose is *derived* from the spec (`renderSpec`, `renderOutcome` in `spec.ts`).
The agent never authors the question twice, once as a widget and once as text.

Outcome states:

- `answered` — `{ value, wasOther }`
- `refused` — user pressed esc
- `unavailable` — no interactive UI (`--print`, RPC, JSON, subagent)

## `required`

`required` decides only one thing: whether a non-answer is a failure.

- `required: true` (default) — refusal or unavailability sets `isError`, and the
  derived text tells the model the intended step did not happen.
- `required: false` — refusal is a normal outcome; the model continues without
  the input.

Nothing blocks dismissal. The renderer always lets the user press esc.

## Tool parameters

```jsonc
{
  "prompt": "Which migration strategy?",   // required
  "options": [                              // required, >= 1
    { "label": "In-place", "description": "Rewrite rows in the existing table" },
    { "label": "Shadow table" }
  ],
  "required": true,      // default true
  "allow_other": true    // default true — appends a free-form entry
}
```

## Keys

- `↑` / `↓` — move
- `enter` — select; on the free-form entry, opens an inline editor
- `esc` — in the editor, back to the list; in the list, refuse

## Scope

MVP covers agent-produced, round-trip, `kind: "select"` only.

Deliberately not built yet:

- **Display-only elements** (`ctx.ui.setWidget`) — no outcome ever, `required`
  is meaningless, and the model already knows the content it emitted. Unresolved
  whether these belong in this data model at all.
- **User-initiated elements** — optional by construction, so they have no error
  channel back to the model; they would inject a `CustomMessage` rather than a
  tool result. Whether they share `ElementSpec` or are a separate kind that
  serializes the same way is open.

## Adding a kind

1. Extend `ElementSpec` in `spec.ts` with the new variant.
2. Add its `renderSpec` / `renderOutcome` branches — do not add a `content`
   string to the spec.
3. Add a renderer in `index.ts` returning the same `Outcome` union.
4. `nh home switch .`

## Verifying a change

```bash
nh home switch .
echo "call the element tool with prompt 'pick a fruit', options apple and pear, required false" | pi --print
```

That exercises the `unavailable` path and confirms the extension loads. The
overlay itself needs an interactive `pi` session.
