# response-pipe

`/pipe <request>` asks the active Pi model for one shell command, supplies the
latest assistant response on stdin, and records successful stdout as the next
pipe response without starting a normal agent turn.

Commands are full-shell commands and inherit the extension's environment and
filesystem access. Before execution, response-pipe evaluates the generated
command against the same permission policy used by Pi's permission gate:

- commands covered by an allow rule (and with covered path arguments) run
  without a second confirmation prompt;
- deny rules block the command, including when `--yes` is used, and the model
  may be asked to generate a policy-compliant replacement;
- commands that are not positively allowlisted retain the normal confirmation
  prompt.

The evaluator is UI-free and reads persisted session grants, so this integration
does not depend on extension load order. Confirmation is enabled by default:

```text
/pipe extract the names from the JSON and output one per line
/pipe --yes sort the lines uniquely
```

Configuration is read from environment variables:

| Variable | Default |
| --- | ---: |
| `PI_RESPONSE_PIPE_SHELL` | `/bin/sh` |
| `PI_RESPONSE_PIPE_TIMEOUT_MS` | `30000` |
| `PI_RESPONSE_PIPE_MAX_STDOUT_BYTES` | `4194304` |
| `PI_RESPONSE_PIPE_MAX_STDERR_BYTES` | `262144` |
| `PI_RESPONSE_PIPE_MAX_REPAIR_ATTEMPTS` | `2` |
| `PI_RESPONSE_PIPE_CONFIRM` | enabled |
| `PI_RESPONSE_PIPE_PERMISSIONS` | enabled |

Set `PI_RESPONSE_PIPE_CONFIRM=0` or use `/pipe --yes ...` (or the
`--pipe-no-confirm` Pi startup flag) to skip confirmation knowingly. Set
`PI_RESPONSE_PIPE_PERMISSIONS=0` only to disable policy integration entirely;
this restores the pre-integration confirmation-only behavior.
