{ pkgs, packages, ... }:
let
  analyzer = packages.tree-sitter-bash-analyzer;
  check =
    pkgs.runCommand "permission-gate-test"
      {
        nativeBuildInputs = [
          pkgs.bun
          analyzer
        ];
        permissionDefaults = builtins.readFile ../../domains/ai/permissions.json;
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
        cp -R ${../../domains/ai/pi/permission-gate}/. "$source/"
        chmod -R u+w "$source"
        bun build "$source/index.ts" --bundle --format=esm --target=bun --external='@earendil-works/pi-coding-agent' --outfile "$bundle"
        HOME="$home" GATE_SOURCE_PATH="$bundle" bun test ${../../domains/ai/pi/permission-gate.test.ts}
        HOME="$home" GATE_SOURCE_PATH="$bundle" bun test ${../../domains/ai/pi/permission-gate.generated.test.ts}
        touch "$out"
      '';
in
{
  checks.permissionGate = check;
}
