{
  description = "Pi harness";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-26.05-darwin";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
        moduleArgs = {
          inherit pkgs;
          packages = result.packages;
        };
        modules = [
          ./nix/modules/pi.nix
          ./nix/modules/analyzer.nix
          ./nix/modules/permission-gate.nix
          ./nix/modules/pi-extensions.nix
          ./nix/modules/committing-mode.nix
        ];
        result =
          builtins.foldl'
            (
              acc: module:
              let
                contribution = import module moduleArgs;
              in
              nixpkgs.lib.recursiveUpdate (nixpkgs.lib.removeAttrs acc [ "devShellPackages" ]) (
                nixpkgs.lib.removeAttrs contribution [ "devShellPackages" ]
              )
              // {
                devShellPackages = acc.devShellPackages ++ (contribution.devShellPackages or [ ]);
              }
            )
            {
              packages = { };
              checks = { };
              devShellPackages = [ ];
            }
            modules;
      in
      (nixpkgs.lib.removeAttrs result [ "devShellPackages" ])
      // {
        devShells.default = pkgs.mkShell {
          packages = nixpkgs.lib.unique result.devShellPackages;
        };
      }
    );
}
