# Tree-sitter Bash analyzer research

This prototype decomposes a Bash command into ordered atomic commands for the Pi permission gate. It deliberately does **not** authorize commands. Policy remains in the generated TypeScript/Nix permission system.

## Contract

```json
{"status":"ok","commands":[{"argv":["jj","status"],"argv_metadata":[{"shell_quoted":false,"shell_escaped":false},{"shell_quoted":false,"shell_escaped":false}]},{"argv":["jj","diff"],"argv_metadata":[{"shell_quoted":false,"shell_escaped":false},{"shell_quoted":false,"shell_escaped":false}],"separator_before":"&&"}]}
```

`argv_metadata` is parallel to `argv` and records shell syntax that was
removed while recovering each argument value. `shell_quoted` is true for
single-, double-, or mixed-quoted arguments; `shell_escaped` is true when a
backslash escape was used. The original `argv` field remains unchanged for
permission-gate consumers.

Unsupported shell constructs, parser errors, dynamic words, or commands whose arguments cannot be recovered statically return `opaque` and a reason. This is conservative: the caller may ask for approval, but must not automatically allow the input.

## Run

```sh
cargo run --manifest-path pi/permission-gate/analyzer/Cargo.toml -- 'jj status && jj diff'
printf 'rg foo file\nrm file\n' | cargo run --manifest-path pi/permission-gate/analyzer/Cargo.toml
cargo run --manifest-path pi/permission-gate/analyzer/Cargo.toml -- audit \
  --log ~/.pi/permission-requests.jsonl \
  --top 25
```

The `reconstruct-sessions` subcommand can create a separate, provenance-marked
JSONL stream from Pi session history:

```sh
tree-sitter-bash-analyzer reconstruct-sessions \
  --sessions ~/.pi/agent/sessions \
  --output /tmp/session-tool-calls.jsonl
```

These records are useful for command frequency and sequence analysis, but have
`prompted: null`, `decision: "unknown"`, and `evaluation_inferred: true`; they
must not be treated as permission decisions. The `audit` subcommand reads
permission-evaluation records, reports prompt and acceptance metrics, ranks
normalized command candidates, and reports repeated normalized command
sequences. It accepts the legacy prompt-only records, but
sets `source.denominator_complete` to false until every record has the new
`prompted` field. Use `--since` to analyze only records written after the gate
started emitting complete evaluation records.

The dependency versions are pinned together because Tree-sitter's language API changes across major versions.
