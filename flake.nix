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
          enable = false;
          context = "${builtins.head commands} use is precluded entirely by ${replacement} (`${replacement} --help` if you're unfamiliar).";
        };
        altPreferences = {
          git = mkAlt [ "git" "git *" "*/git" "*/git *" ] "jj" [ pkgs.jujutsu ];
          find = mkAlt [ "find" "find *" ] "fd" [ pkgs.fd ];
          grep = mkAlt [ "grep" "grep *" ] "rg" [ pkgs.ripgrep ];
        };
        moduleOptions = import ./nix/options.nix { inherit (nixpkgs) lib; };
        piExtensions = moduleOptions.options.piExtensions.default;
        modules = [
          ./nix/modules/pi.nix
          ./nix/modules/analyzer.nix
          ./nix/modules/permission-gate.nix
          ./nix/modules/pi-extensions.nix
          ./nix/modules/committing-mode.nix
        ];
        # Models are host policy, so the outputs are built as a function of
        # them: the flake's own outputs use the registry defaults, while
        # consumers can build a configuration for their own model choices.
        mkResult =
          {
            models ? { },
            bashAlts ? altPreferences,
            extensionOpts ? piExtensions,
          }:
          let
            moduleArgs = {
              inherit pkgs models;
              altPreferences = bashAlts;
              piExtensions = extensionOpts;
              packages = result.packages;
            };
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
          result;
        result = mkResult { };
      in
      (nixpkgs.lib.removeAttrs result [ "devShellPackages" ])
      // {
        devShells.default = pkgs.mkShell {
          packages = nixpkgs.lib.unique result.devShellPackages;
        };

        # Consumers (other harnesses, other hosts) build from the same registry
        # and the same packaged configuration.
        lib = {
          # Expose the option defaults so downstream flakes can extend or
          # override the shared command alternatives and extension selection.
          bashAlts = altPreferences;
          extensionOpts = piExtensions;

          agents =
            models:
            import ./nix/agents.nix {
              inherit (nixpkgs) lib;
              inherit models;
            };
          mkPi =
            {
              models ? { },
              bashAlts ? altPreferences,
              extensionOpts ? piExtensions,
            }:
            (mkResult { inherit models bashAlts extensionOpts; }).packages.pi;
        };
      }
    );
}
