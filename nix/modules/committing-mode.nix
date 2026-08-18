{ pkgs, ... }:
let
  check =
    pkgs.runCommand "committing-mode-test"
      {
        nativeBuildInputs = [ pkgs.bun ];
        source = ../../domains/ai/pi/committing-mode/index.ts;
      }
      ''
        bun --check "$source"
        touch "$out"
      '';
in
{
  checks.committingMode = check;
}
