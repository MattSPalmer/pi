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
          packages = packagesModule;
        };
        packagesModule = import ./nix/modules/packages.nix moduleArgs;
        devShellsModule = import ./nix/modules/dev-shells.nix moduleArgs;
        checksModule = import ./nix/modules/checks.nix moduleArgs;
      in
      {
        packages = packagesModule;
        devShells = devShellsModule;
        checks = checksModule;
      }
    );
}
