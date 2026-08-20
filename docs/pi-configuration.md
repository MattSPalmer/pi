# Pi configuration

This document explains the local Pi setup as a standalone configuration. It separates Pi's ordinary capabilities from the additions made for this workstation.

## Two layers

**Pi out of the box** — Pi provides the interactive coding-assistant runtime: model selection, sessions, prompt templates, delegated agents, built-in file and shell tools, themes, thinking-level controls, and the extension mechanism.

**This configuration** — The local setup supplies model defaults, a restricted model list, custom prompt templates and agents, custom extensions, a permission gate, a session synchronizer, and small automation commands. Those additions are described explicitly below rather than being presented as Pi's default behavior.

The setup's normal launcher starts Pi and synchronizes the AI-session database when the session exits. That launcher, the synchronizer, and the other commands described under automation are local additions.

## Local model and interface choices

Pi provides the settings file and its ordinary interface options. This setup chooses the following values in `~/.pi/agent/settings.json`:

- The default provider is GitHub Copilot.
- The default model is `gpt-5.6-luna`.
- Thinking starts at the `low` level.
- Thinking blocks are hidden in the normal display.
- The interface uses the dark theme.
- The model picker is restricted to a short preferred list, including Luna, Sonnet, Opus, Gemini, Kimi, Grok, Haiku, and Terra variants.

The model list is deliberately explicit. A model is available for selection only when it appears in `enabledModels`; this keeps routine model selection predictable rather than exposing every provider model.

This setup also adds a small `fd` wrapper at `~/.pi/agent/bin/fd`. It delegates to the system `fd` executable but rejects `-x` and `-X`, preventing file searches from turning into arbitrary command execution.

A local OpenAI-compatible model is registered for the desktop LLM client at `http://127.0.0.1:1234/v1`. This is a local addition and is separate from Pi's preferred hosted-model list.

## Custom prompt templates and delegated agents

Pi provides the distinction between interactive prompt templates and delegated subagent definitions. This setup populates that mechanism with its own agents. Each definition has a description, optional model selection, an optional tool list, and instructions.

The common operating contract is a local addition. It emphasizes:

- leading with the result;
- separating observed facts, inferences, unknowns, and actions;
- reducing unnecessary operator effort;
- reporting verified results rather than implied success;
- avoiding social filler and unsupported certainty.

Most agents also receive a communication contract that defines response shape, technical vocabulary, correction style, and scope discipline. A few machine-facing agents omit that contract because they must return a strict format such as raw JSON or a commit message.

### Read-only repository agents

These agents can inspect a repository but cannot modify it:

- **`context-preflight`** — builds a bounded context package for a downstream expensive agent; returns both a Markdown brief and traceable JSON evidence.
- **`strategic-agent`** — performs the main analysis from the supplied context package and does not independently explore beyond that evidence.
- **`explore`** — performs fast, read-only codebase reconnaissance.
- **`implementer`** — designs a mergeable implementation proposal without applying changes.
- **`technical-voice`** — rewrites text in the configured technical writing voice.
- **`draft-pr-notes`** — drafts pull-request notes and saves them to a temporary file.
- **`cargo-dep-reader`** — answers questions from Rust dependency sources already present locally; it does not fetch or build missing sources.

### Task-specific agents

- **`pr-aggregator`** — collects open pull requests authored by the current user in the `chronogolf` organization and produces a categorized report.
- **`pr-chunker`** — identifies logical change chunks, classifies them by category, leverage, and scope, then writes a report to a temporary file.
- **`jj-change-describer`** — turns a completed diff into a concise conventional-style change description; its output is only the description text.
- **`rubber-duck`** — helps structure a problem by asking one focused question at a time before work begins.
- **`iterative-editor`** — proposes successive text transformations without directly modifying repository files.

### Review ensemble

`review-heatmap` is an interactive orchestration prompt for a falsification-oriented review experiment. It:

1. obtains a bounded diff summary;
2. identifies logical chunks and writes a normalized JSON payload;
3. sends the identical payload to five independent, tool-less review lenses;
4. repeats one lens to measure self-noise;
5. computes mean scores and variance;
6. classifies chunks as contested, consensus risk, or quiet;
7. saves canonical JSON and prints a Markdown report.

The five lenses are deliberately narrow:

- API and interface design;
- reviewer empathy, meaning susceptibility to misreading;
- codebase idiom;
- visible performance patterns;
- security and data exposure.

The lenses see only the supplied chunk text. They cannot inspect the repository or influence one another. The duplicate run provides a noise baseline, so disagreement is not treated as meaningful without comparison to repeat-run variation.

Each review lens has no tools and returns one raw JSON object with one score per input chunk. This makes the ensemble output machine-parseable and keeps the experiment's inputs controlled.

## Custom extensions

Pi provides the extension mechanism. The extensions listed here are local additions; they add behavior around safety, interaction, bookkeeping, and delegation.

### Permission gate

`permission-gate` is the central safety extension. It checks file-oriented tools (`read`, `edit`, `write`, `ls`, `grep`, and `find`) and shell commands before they execute.

Its behavior is layered:

1. baseline rules define allowed, approval-required, and denied commands and paths;
2. an agent-specific scope can replace or narrow those rules;
3. project-local `.pi/permissions.json` files layer from an ancestor directory toward the current project;
4. explicit session grants can persist in the Pi session;
5. the startup directory is trusted for the current session.

Paths are canonicalized before matching. Existing path components are resolved, while missing components are attached to the nearest existing ancestor. This prevents simple spelling differences or symlink paths from bypassing a rule.

Unknown or ambiguous paths require an interactive choice of scope, followed by a choice between one-use access, session access, or denial. If no user interface is available, approval-required operations are blocked rather than silently allowed.

Shell commands are analyzed with a tree-sitter-based parser. Opaque interpreters such as `bash`, `node`, `python`, `ruby`, `sh`, and `zsh` require approval. Shell control syntax, unsafe expansion, and malformed analysis also require approval. Explicit filesystem arguments and redirect targets are checked separately, so a command-level allow does not automatically authorize access to a sensitive path.

Denied rules win over ordinary matches. Session grants can reduce repeated prompts, but they do not bypass command parsing or explicit deny rules. Delegated agents do not have an approval UI, so an approval-required action is denied for them.

### Permission proposals

The proposal extension lets an interactive agent request a narrowly scoped command or path grant. Accepted grants are recorded in the session so the permission gate can use them during the same turn and after a session reload. A proposal is an exact command grant or a selected directory scope; it is not a way to create a broad, arbitrary shell policy.

### Interactive elements

The elements extension supplies structured UI interactions used by Pi extensions and prompts. Its specification is kept beside the implementation so callers can rely on a defined input and output shape.

### Committing mode

The committing-mode extension supports automatic jj change boundaries after a
successful task. It normally operates in Pi's current directory. Polyrepo
consumers can select the workspace programmatically with
`PI_COMMITTING_WORKSPACE` (absolute or relative to Pi's starting directory).
The current integration targets one consumer per task; multi-consumer tasks
should select a target explicitly or disable the mode.

### Cost status

The cost-status extension displays usage information and maintains a ledger. The ledger is stored separately from the display code so reporting can evolve without changing accounting behavior.

### Delegated subagents

The subagent extension launches the definitions in `~/.pi/agent/agents`. It passes the delegated agent's name through `PI_SUBAGENT_NAME`, allowing the permission gate to select that agent's rules.

The extension recognizes `tools: none` as a real no-tools configuration. This matters for the review lenses and the commit-message agent: they must receive only their prompt input and must not gain accidental repository or shell access.

## Permissions by agent

The default agent tool policy is straightforward:

- omitted tool lists use Pi's ordinary default tools;
- an explicit list grants only those tools;
- an empty list grants no tools.

Notable restrictions include:

- `context-preflight`, `strategic-agent`, `explore`, and `implementer` are read-only;
- `cargo-dep-reader` can read only Cargo and Rustup directories outside the normal repository scope;
- `pr-aggregator` may run only the approved pull-request search and view commands;
- `iterative-editor` may use only its approved search and listing commands;
- the review lenses and `jj-change-describer` have no tools;
- `rubber-duck` has the full interactive tool set because it is a user-driven primary mode.

These restrictions are expressed both in the agent definitions and in the permission gate. Tool visibility limits what an agent can request; command and path rules provide the enforcement boundary when a tool is available.

## Project-local permissions

A project can add `.pi/permissions.json` without changing the profile-wide configuration. It may contain direct command rules, path allows and denies, or categorized rules. `READ` allows by default; `WRITE`, `NETWORK`, and `ADMIN` require approval; `DENY` is a hard block; and `ALT` is a hard block used when a safer replacement command is prescribed (for example, `fd` instead of `find` or `rg` instead of `grep`). The categories work for Bash commands, paths, and any namespaced executable policy. Direct Bash rules, the former top-level `jj` namespace, and the legacy `paths.allow`/`paths.deny` keys remain supported:

```json
{
  "bash": {
    "rg *": "allow"
  },
  "paths": {
    "READ": ["./src/**"],
    "WRITE": ["./generated/**"],
    "ADMIN": ["~/.ssh/**"]
  },
  "bash": {
    "READ": ["rg *", "ls *"],
    "NETWORK": ["curl *"]
  },
  "commands": {
    "jj": {
      "READ": ["status", "diff"],
      "WRITE": ["commit"]
    }
  }
}
```

Rules from nearer project directories take precedence over rules from ancestors. A malformed policy is ignored with a diagnostic; it does not disable the global permission gate.

The packaged alternatives use this same shape declaratively. Enabling an
alternative activates its displaced-command denial, replacement package, and
replacement policy as one unit. That keeps `fd` and `rg` permissions beside
their alternatives while allowing `jj` to contribute its full categorized
subcommand policy without hard-coding Jujutsu in the loader.

## Automation around Pi

Several commands use Pi as a controlled non-interactive component:

- **Commit descriptions** — a diff is supplied on standard input; Pi runs with high thinking, no session, no tools, no extensions, no skills, no prompt templates, no themes, and no context files; output is only a commit description.
- **Session synchronization** — the normal launcher imports session information into the shared AI-session database after Pi exits, while preserving Pi's exit status.
- **Prompt-driven text transforms** — a floating prompt tool can replace, append, or diff generated text; optional reflection improves the transformation instruction before execution.
- **Diff inspection** — a digest command gives review agents a bounded overview before they request a full diff for a particular file.

The key distinction is between interactive Pi sessions, where extensions and approvals are available, and automation, where the invocation explicitly disables ambient features and supplies a narrow system instruction.

## Typical usage

For ordinary work, start Pi with the locally provided `pi` command. Begin in the repository whose files should be trusted for the session; access outside that scope will trigger a path decision when no rule already covers it.

Use Pi's prompt-template and delegation features with the locally supplied modes: `/rubber-duck`, `/iterative-editor`, and `/review-heatmap` are primary modes, while `context-preflight`, `strategic-agent`, and the review lenses are delegated agents.

When asking for a machine-readable result, use an agent or invocation whose output contract explicitly requires raw JSON or plain text; do not rely on conversational formatting in that case.

## Design summary

Pi supplies the runtime primitives; this configuration combines them using a small number of explicit local mechanisms:

- a constrained model picker rather than an unrestricted catalog;
- read-only analysis stages before implementation;
- independent review lenses with controlled inputs;
- static shell analysis before approval decisions;
- canonical path matching and explicit session grants;
- no-tools agents for tasks that should judge text only;
- separate interactive and non-interactive entry points.

The result is a Pi installation that is useful for normal repository work, but whose delegated agents and automation paths have materially narrower authority than the interactive operator.
