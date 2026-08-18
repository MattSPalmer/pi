{ pkgs, ... }:
let
  analyzer = pkgs.rustPlatform.buildRustPackage {
    pname = "tree-sitter-bash-analyzer";
    version = "0.1.0";
    src = ../../pi/permission-gate/analyzer;
    cargoLock.lockFile = ../../pi/permission-gate/analyzer/Cargo.lock;
    meta.mainProgram = "tree-sitter-bash-analyzer";
  };
in
{
  packages.tree-sitter-bash-analyzer = analyzer;
  checks.tree-sitter-bash-analyzer = analyzer;
}
