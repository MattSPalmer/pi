# pi writeup

Pi is an interactive coding-agent runtime. It provides a model-driven session, built-in tools for reading and modifying files and running shell commands, model and thinking-level controls, prompt templates, delegated agents, and a powerful extension API.

Pi supplies these runtime primitives; the surrounding configuration determines the operational policy. A useful way to evaluate a Pi installation is therefore to consider both layers separately:

- **Pi itself** provides a core agent loop, tool interface, session model and extension points. (It's quite small and basic; see pi.dev for a cheeky list of all the things it *doesn't* have) 
- **The local configuration** determines which models, agents, tools, permissions, and automation paths are available. Broad, nearly arbitrary customization is possible at this layer.

## Delegation as a control boundary

Pi distinguishes between interactive prompt templates and delegated subagents. A prompt template is an operator-facing workflow. A delegated agent is a separately configured worker with its own instructions, model, and tool list.

That distinction supports more than context management. It also supports least-privilege workflows, as exemplified in agents from the example configuration:

- `context-preflight` performs bounded, read-only repository analysis and produces a context package containing Markdown and traceable JSON evidence.
- `strategic-agent` performs analysis from that supplied package rather than independently exploring the repository.
- `explore` and `implementer` provide read-only reconnaissance and implementation planning without applying changes.
- `jj-change-describer` and the review lenses have no tools. They receive input and return a constrained textual or JSON result without repository or shell access.

The tool list is an important part of each agent's contract. An omitted list uses the configured default tools; an explicit list narrows the available tools; an empty list grants none. In this configuration, no-tools agents are implemented as an explicit mode rather than as an informal instruction in the prompt.

### Controlled review fan-out

The `review-heatmap` workflow demonstrates how delegation can be used to control evaluation inputs. It creates a bounded diff summary, identifies logical chunks, and writes a normalized JSON payload. The same payload is then sent to five independent review lenses covering:

- API and interface design;
- reviewer empathy, or susceptibility to misinterpretation;
- codebase idiom;
- visible performance characteristics;
- security and data exposure.

Each lens sees only the supplied chunk text and returns one JSON object with a score for each chunk. One lens is run again to estimate repeat-run variation. The workflow uses that variation when interpreting disagreement between lenses, rather than treating every difference as a meaningful consensus signal.

This arrangement does not make the review objectively correct. It does make the inputs, outputs, and sources of disagreement more explicit and reproducible.

## Permission enforcement

The `permission-gate` extension is the primary local safety mechanism. It intercepts file-oriented tools and shell commands before execution. Its policy is layered:

1. baseline rules classify commands and paths as allowed, approval-required, or denied;
2. agent-specific scopes apply the relevant delegated-agent policy;
3. project-local `.pi/permissions.json` files layer from ancestor directories toward the current project;
4. accepted session grants avoid repeating the same interaction;
5. the startup directory is trusted for the current session.

The policy is evaluated against canonicalized paths. Existing path components are resolved, and missing components are joined to the nearest existing ancestor. This gives equivalent path spellings and symlinked paths a consistent basis for matching.

Shell analysis uses a tree-sitter parser rather than relying only on string patterns. Opaque interpreters such as `bash`, `node`, `python`, `ruby`, `sh`, and `zsh` require approval. Shell control syntax, unsafe expansion, and malformed analysis also require approval. Explicit filesystem arguments and redirect targets are checked independently, so an allowed command does not implicitly authorize access to every path it could reference.

Denied rules take precedence over ordinary matches. Session grants do not bypass explicit denials or command parsing. Delegated agents do not have an approval interface; an operation that requires approval is therefore denied when requested by a delegated agent.

The configuration also wraps `fd` and rejects its `-x` and `-X` options. Those options can turn a file search into command execution, so the wrapper keeps the commonly used search interface separate from that execution capability.

A companion permission-proposal extension allows an interactive agent to request a narrowly scoped grant. The operator can accept an exact command grant or a selected directory scope for the session. This provides a structured alternative to weakening the general policy.

## Interactive and automated operation

The configuration uses Pi in two distinct ways.

Interactive sessions provide the normal tools, extensions, prompt templates, and approval workflow. The launcher begins in the repository intended for the session and synchronizes session information into a shared AI-session database after Pi exits, while preserving Pi's exit status.

Automation invokes Pi with a deliberately reduced environment. For example, commit-description generation supplies a diff on standard input and disables sessions, tools, extensions, skills, prompt templates, themes, and context files. The invocation requests only a commit description as output.

Keeping these entry points separate prevents an unattended task from inheriting the authority or ambient state of an interactive session. It also gives callers a clearer contract: interactive workflows are extensible and operator-mediated; automated workflows are narrowly configured and machine-oriented.

## Configuration choices

The local settings choose GitHub Copilot as the default provider, `gpt-5.6-luna` as the default model, and `low` as the initial thinking level. Thinking blocks are hidden in the normal display, and the interface uses the dark theme. The model picker is restricted to an explicit preferred list covering selected Luna, Sonnet, Opus, Gemini, Kimi, Grok, Haiku, and Terra variants.

The explicit model list keeps routine selection predictable. It is a local selection policy, not a limitation imposed by Pi's runtime.

The setup also registers a local OpenAI-compatible model for the desktop LLM client at `http://127.0.0.1:1234/v1`. That registration is separate from Pi's hosted-model preferences. A small `fd` wrapper is installed under `~/.pi/agent/bin/fd` as an additional local command restriction.

## Assessment

Pi is most useful here as a set of composable mechanisms rather than as a pre-defined operating model. The local configuration combines those mechanisms into several explicit boundaries:

- model availability is restricted to a maintained list;
- analysis can precede implementation and remain read-only;
- delegated agents receive only the tools appropriate to their task;
- shell and path access is evaluated before execution;
- approval-required operations fail closed for delegated agents;
- review agents can operate on identical, bounded inputs;
- interactive and automated invocations have different authority.

These choices do not eliminate the risks of using an agent with filesystem and shell access. They reduce the amount of authority granted to individual workflows and make the remaining authority more visible. For a staff developer evaluating Pi, the extension and delegation APIs are the key capabilities: they allow the runtime to be adapted to an explicit operational model instead of leaving that model entirely to prompts and operator discipline.
