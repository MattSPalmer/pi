{ pkgs, packages, ... }:
let
  analyzer = packages.tree-sitter-bash-analyzer;
  permissionLib = import ../permissions.nix { inherit (pkgs) lib; };
  basePermissions = builtins.fromJSON (builtins.readFile ../../permissions.json);
  bashAlts = import ../bash-alts.nix { inherit pkgs; };
  permissionDefaults = permissionLib.render (
    permissionLib.mergeAll (
      [ basePermissions ]
      ++ pkgs.lib.concatMap (alt: [
        alt.permissions
        (permissionLib.altFragment alt)
      ]) (builtins.attrValues bashAlts)
    )
  );
  check =
    pkgs.runCommand "permission-gate-test"
      {
        nativeBuildInputs = [
          pkgs.bun
          analyzer
        ];
        permissionDefaults = builtins.toJSON permissionDefaults;
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
        cp -R ${../../pi/permission-gate}/. "$source/"
        chmod -R u+w "$source"
        bun build "$source/index.ts" --bundle --format=esm --target=bun --external='@earendil-works/pi-coding-agent' --outfile "$bundle"
        HOME="$home" GATE_SOURCE_PATH="$bundle" bun test ${../../pi/permission-gate.test.ts}
        HOME="$home" GATE_SOURCE_PATH="$bundle" bun test ${../../pi/permission-gate.generated.test.ts}
        touch "$out"
      '';
in
{
  devShellPackages = [ pkgs.bun ];
  checks.permissionGate = check;
}
