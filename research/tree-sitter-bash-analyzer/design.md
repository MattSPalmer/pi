# Bash command decomposition design

## Goal

Replace the permission gate's intentionally small tokenizer with a Rust helper that uses the pinned `tree-sitter-bash` grammar to expose ordered `argv` vectors. The helper is an analyzer, not an authorization engine.

## Pipeline

1. Generated Pi extension receives raw Bash text.
2. It invokes the Nix-built analyzer synchronously.
3. The analyzer parses the complete input and rejects syntax errors.
4. It emits atomic commands in source order, or `opaque` with a reason.
5. The extension evaluates every emitted argv against existing deny/allow/ask rules.
6. Candidate path arguments are passed to the existing canonical path gate.
7. Aggregation is deny-first: one denied command denies the full request; otherwise any ask requires approval.
8. Opaque output follows the existing approval path and never becomes an automatic allow.

## Initial scope

Supported initially:

- simple commands
- command names and static word arguments
- `;`, `&&`, `||`, and newlines as ordering/separator context

Opaque initially:

- parser errors
- parameter, command, arithmetic, and process substitution
- variable assignments
- redirections and here-documents
- subshells and function definitions
- dynamically constructed command names or arguments

This scope is intentionally narrower than Bash. Tree-sitter error recovery is useful for diagnostics but is not authorization evidence.

## JSON schema

```json
{"status":"ok","commands":[{"argv":["rg","needle","src"],"argv_metadata":[{"shell_quoted":false,"shell_escaped":false},{"shell_quoted":false,"shell_escaped":false},{"shell_quoted":false,"shell_escaped":false}],"separator_before":null}]}
{"status":"opaque","reason":"dynamic expansion is opaque"}
```

`argv_metadata` is parallel to `argv`. It records whether each recovered
argument used shell quoting or a backslash escape before the analyzer removed
that syntax from the stable `argv` values. Existing consumers may continue to
ignore this field.

The schema remains intentionally minimal. Source ranges, path roles,
redirects, and nested structure can be added only after fixture-driven
behavior is stable.

## Policy compatibility

The Rust program must not duplicate `domains/ai/permissions.nix`. The TypeScript adapter should consume `argv` directly, while retaining current rule precedence and path canonicalization. During migration, the existing tokenizer should remain available as a fallback if the helper is missing or returns malformed JSON.

## Security invariants

- No parse error is safe.
- No opaque result is safe by default.
- Explicit deny rules are evaluated before allows.
- Every command in a compound input is evaluated.
- Path candidates are checked independently of command authorization.
- Analyzer failure, timeout, malformed output, or unavailable binary fails closed to approval/denial according to the existing UI context.
- The analyzer stores no authorization state.

## Audit output

The `audit` subcommand consumes permission-evaluation JSONL records. It reports:

- prompt rate over all evaluated Bash/path events when the denominator is complete;
- acceptance ratio over prompted events;
- normalized command candidates, with flags represented as an unordered name/count map;
- repeated normalized command sequences within sessions.

Normalization starts with every non-flag positional as a slot. For each base
cluster, slot 1 is promoted to a literal only for values occurring more than
once; deeper positional promotion is intentionally deferred. Known flag-value
forms are stripped conservatively; unknown `--x foo` forms retain `foo` as a
positional until command-specific flag metadata exists.

## Next steps

1. Add fixture tests for simple commands, separators, quoting, comments, malformed input, and expansions.
2. Confirm the exact `tree-sitter-bash` node names/API against the pinned versions in Nix CI.
3. Add command-specific flag metadata and deeper positional promotion.
4. Add session-history fields for command-level outcomes when compound requests need per-command attribution.
