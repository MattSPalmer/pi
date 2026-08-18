# Pi Harness

A reproducible [Pi coding agent](https://github.com/earendil-works/pi) setup packaged with Nix. The flake builds Pi, installs the project-owned agents and extensions, and includes a Bash permission analyzer used by the test suite.

## Requirements

- [Nix](https://nixos.org/download/) with flakes enabled
- macOS Apple Silicon, macOS Intel, Linux ARM64, or Linux x86_64

Bun and `jq` are provided by the development shell; they do not need to be installed separately when using the flake commands.

## Quick start

Run the packaged agent directly (the configuration directory is required):

```sh
PI_CONFIG_DIR="$PWD/.pi" nix run
```

Enter a development shell:

```sh
nix develop
```

Build the default package:

```sh
nix build
```

Run all checks:

```sh
nix flake check
```

The flake is pinned by `flake.lock`; update inputs intentionally with:

```sh
nix flake update
```

## Configuration

The wrapper installs the repository's Pi configuration into the directory specified by `PI_CONFIG_DIR`. This variable must be set; the wrapper intentionally does not default to `$HOME/.pi`:

```sh
PI_CONFIG_DIR="$PWD/.pi" nix run
```

If it is unset, the wrapper exits with an explanatory error before starting Pi.

Packaged agents are available as both Pi agents and prompts. Project extensions and the default permission policy are linked into the same configuration directory. Mutable Pi state—sessions, settings, and logs—remains outside the Nix store.

## Repository layout

- `flake.nix` — package, development shell, and check definitions
- `pkgs/pi/` — pinned, offline Nix build of the upstream Pi coding agent
- `domains/ai/agents/` — project agents and prompts
- `domains/ai/pi/` — project Pi extensions and their tests
- `domains/ai/permissions.json` — default permission policy
- `research/tree-sitter-bash-analyzer/` — Rust-based shell command analyzer
- `docs/` — design notes and configuration documentation

## Development

Most TypeScript extension checks run through the Nix check named `piExtensions`. The permission gate is checked separately as `permissionGate`, and the Rust analyzer is built as `tree-sitter-bash-analyzer`.

To inspect the available flake outputs:

```sh
nix flake show
```

Changes to packaged agents, extensions, permissions, or the analyzer are included automatically in the next Nix build. The Pi dependency itself is pinned in `pkgs/pi/default.nix` and should be updated together with its source and dependency hashes.
