{ pkgs, ... }:
let
  analyzer = pkgs.rustPlatform.buildRustPackage {
    pname = "tree-sitter-bash-analyzer";
    version = "0.1.0";
    src = ../../research/tree-sitter-bash-analyzer;
    cargoLock.lockFile = ../../research/tree-sitter-bash-analyzer/Cargo.lock;
    meta.mainProgram = "tree-sitter-bash-analyzer";
  };
in
{
  packages.tree-sitter-bash-analyzer = analyzer;
  checks.tree-sitter-bash-analyzer = analyzer;
}
