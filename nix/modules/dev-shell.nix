{ pkgs, ... }:
{
  devShells.default = pkgs.mkShell {
    packages = [
      pkgs.bun
      pkgs.jq
    ];
  };
}
