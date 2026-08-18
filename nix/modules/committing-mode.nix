{ pkgs, ... }:
let
  check =
    pkgs.runCommand "committing-mode-test"
      {
        nativeBuildInputs = [ pkgs.bun ];
        source = ../../pi/committing-mode/index.ts;
      }
      ''
        bun --check "$source"
        touch "$out"
      '';
in
{
  devShellPackages = [ pkgs.bun ];
  checks.committingMode = check;
}
