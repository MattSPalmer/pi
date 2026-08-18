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
        mkAlt = commands: replacement: packages: {
          inherit commands packages;
          context = "${builtins.head commands} use is precluded entirely by ${replacement} (`${replacement} --help` if you're unfamiliar).";
        };
        altPreferences = {
          git = mkAlt [ "git" "git *" "*/git" "*/git *" ] "jj" [ pkgs.jujutsu ];
          find = mkAlt [ "find" "find *" ] "fd" [ pkgs.fd ];
          grep = mkAlt [ "grep" "grep *" ] "rg" [ pkgs.ripgrep ];
        };
        moduleArgs = {
          inherit pkgs altPreferences;
          packages = result.packages;
        };
        moduleOptions = import ./nix/options.nix { inherit (nixpkgs) lib; };
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
              with nixpkgs.lib;
              recursiveUpdate (removeAttrs acc [ "devShellPackages" ]) (
                removeAttrs contribution [ "devShellPackages" ]
              )
              // {
                devShellPackages = moduleOptions.options.devShellPackages.type.merge "devShellPackages" [
                  {
                    file = "acc";
                    value = acc.devShellPackages;
                  }
                  {
                    file = "${toString module}";
                    value = contribution.devShellPackages or [ ];
                  }
                ];
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
