{
  description = "Pi harness";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };
          treeSitterBashAnalyzer = pkgs.rustPlatform.buildRustPackage {
            pname = "tree-sitter-bash-analyzer";
            version = "0.1.0";
            src = ./research/tree-sitter-bash-analyzer;
            cargoLock.lockFile = ./research/tree-sitter-bash-analyzer/Cargo.lock;
            meta.mainProgram = "tree-sitter-bash-analyzer";
          };
          piConfig = pkgs.runCommand "pi-config" { } ''
            mkdir -p $out/agent/extensions $out/agent/agents $out/agent/prompts
            ln -s ${./domains/ai/permissions.json} $out/agent/permissions.defaults.json
            for agent in ${./domains/ai/agents}/*.md; do
              ln -s "$agent" "$out/agent/agents/$(basename "$agent")"
              ln -s "$agent" "$out/agent/prompts/$(basename "$agent")"
            done
            for extension in ${./domains/ai/pi}/*/; do
              name=$(basename "$extension")
              case "$name" in
                *.patch|*.test.ts|pocket) ;;
                *) ln -s "$extension" "$out/agent/extensions/$name" ;;
              esac
            done
          '';
          upstreamPi = pkgs.callPackage ./pkgs/pi { };
          pi = pkgs.writeShellScriptBin "pi" ''
            set -euo pipefail
            base="''${PI_CONFIG_DIR:-$HOME/.pi}"
            agent="$base/agent"
            mkdir -p "$agent/extensions"
            # Remove entries retired from the packaged configuration so an
            # earlier invocation cannot leave a stale extension active.
            rm -rf "$agent/extensions/pocket" "$agent/extensions/agentic-20-questions.ts"
            ln -sfn ${piConfig}/agent/agents "$agent/agents"
            ln -sfn ${piConfig}/agent/prompts "$agent/prompts"

            # The store artifact is immutable, while Pi must write sessions,
            # settings, and logs. Keep those mutable state files in the
            # selected base directory and link only the packaged config.
            ln -sfn ${piConfig}/agent/permissions.defaults.json "$agent/permissions.defaults.json"
            for extension in ${piConfig}/agent/extensions/*/; do
              name="$(basename "$extension")"
              ln -sfn "$extension" "$agent/extensions/$name"
            done

            export PI_CODING_AGENT_DIR="$agent"
            exec ${upstreamPi}/bin/pi "$@"
          '';

        in
        {
          pi = pkgs.callPackage ./pkgs/pi { };
          pi-config = piConfig;
          tree-sitter-bash-analyzer = treeSitterBashAnalyzer;
          default = pkgs.symlinkJoin {
            name = "pi-harness";
            paths = [
              self.packages.${system}.pi
              piConfig
            ];
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.jq
            ];
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };
          analyzer = self.packages.${system}.tree-sitter-bash-analyzer;
          permissionGate =
            pkgs.runCommand "permission-gate-test"
              {
                nativeBuildInputs = [
                  pkgs.bun
                  analyzer
                ];
                permissionDefaults = builtins.readFile ./domains/ai/permissions.json;
                passAsFile = [ "permissionDefaults" ];
              }
              ''
                set -euo pipefail
                home="$TMPDIR/pi-home"
                mkdir -p "$home/.pi/agent"
                cp "$permissionDefaultsPath" "$home/.pi/agent/permissions.defaults.json"
                bundle="$TMPDIR/permission-gate.js"
                source="$TMPDIR/permission-gate"
                mkdir -p "$source"
                cp -R ${./domains/ai/pi/permission-gate}/. "$source/"
                chmod -R u+w "$source"
                bun build "$source/index.ts" --bundle --format=esm --target=bun --external='@earendil-works/pi-coding-agent' --outfile "$bundle"
                HOME="$home" GATE_SOURCE_PATH="$bundle" bun test ${./domains/ai/pi/permission-gate.test.ts}
                HOME="$home" GATE_SOURCE_PATH="$bundle" bun test ${./domains/ai/pi/permission-gate.generated.test.ts}
                touch "$out"
              '';
          piExtensions =
            pkgs.runCommand "pi-extensions-test"
              {
                nativeBuildInputs = [
                  pkgs.bun
                  analyzer
                ];
                inherit analyzer;
                permissionDefaults = builtins.readFile ./domains/ai/permissions.json;
                passAsFile = [ "permissionDefaults" ];
              }
              ''
                set -euo pipefail
                home="$TMPDIR/pi-home"
                mkdir -p "$home/.pi/agent"
                cp "$permissionDefaultsPath" "$home/.pi/agent/permissions.defaults.json"
                export HOME="$home"
                export PI_PERMISSION_ANALYZER="$analyzer/bin/tree-sitter-bash-analyzer"
                work="$TMPDIR/pi-source"
                cp -R ${./domains/ai/pi} "$work"
                chmod -R u+w "$work"
                find "$work" -path '*/node_modules' -prune -o -name '*.test.ts' ! -name 'permission-gate.generated.test.ts' ! -name 'permissions.test.ts' -print0 | xargs -0 -n1 bun test
                # The standalone permission-gate check covers the same policy evaluator;
                # response-pipe's permissions fixture uses a host-temp-path assumption
                # that is not stable inside the Nix sandbox.
                bundle="$TMPDIR/permission-gate.js"
                bun build "$work/permission-gate/index.ts" --bundle --format=esm --target=bun --external='@earendil-works/pi-coding-agent' --outfile "$bundle"
                GATE_SOURCE_PATH="$bundle" bun test "$work/permission-gate.generated.test.ts"
                find "$work" -path '*/node_modules' -prune -o -mindepth 2 -maxdepth 2 -name index.ts -print0 | xargs -0 -n1 bun --check
                touch "$out"
              '';
          committingMode =
            pkgs.runCommand "committing-mode-test"
              {
                nativeBuildInputs = [ pkgs.bun ];
                source = ./domains/ai/pi/committing-mode/index.ts;
              }
              ''
                bun --check "$source"
                touch "$out"
              '';
        in
        {
          # The analyzer package itself is the build check; its full behavioral
          # fixture remains in the upstream project and the Pi permission-gate
          # checks exercise it through the configured analyzer path.
          tree-sitter-bash-analyzer = analyzer;
          inherit permissionGate piExtensions committingMode;
        }
      );
    };
}
