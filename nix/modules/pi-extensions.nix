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
    pkgs.runCommand "pi-extensions-test"
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
        export HOME="$home"
        export PI_PERMISSION_ANALYZER="${analyzer}/bin/tree-sitter-bash-analyzer"
        work="$TMPDIR/pi-source"
        cp -R ${../../pi} "$work"
        chmod -R u+w "$work"
        find "$work" -path '*/node_modules' -prune -o -name '*.test.ts' ! -name 'permission-gate.generated.test.ts' ! -name 'permissions.test.ts' -print0 | xargs -0 -n1 bun test
        bundle="$TMPDIR/permission-gate.js"
        bun build "$work/permission-gate/index.ts" --bundle --format=esm --target=bun --external='@earendil-works/pi-coding-agent' --outfile "$bundle"
        GATE_SOURCE_PATH="$bundle" bun test "$work/permission-gate.generated.test.ts"
        find "$work" -path '*/node_modules' -prune -o -mindepth 2 -maxdepth 2 -name index.ts -print0 | xargs -0 -n1 bun --check
        touch "$out"
      '';
in
{
  devShellPackages = [
    pkgs.bun
    pkgs.jq
  ];
  checks.piExtensions = check;
}
