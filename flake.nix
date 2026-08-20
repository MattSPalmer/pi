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
        # Each alternative is one declarative unit: the displaced command,
        # replacement package, and replacement permissions are activated
        # together. Rich command policies (such as jj's) use the same shape as
        # simple shell replacements rather than a parallel special case.
        bashAlts = import ./nix/bash-alts.nix { inherit pkgs; };
        moduleOptions = import ./nix/options.nix { inherit (nixpkgs) lib; };
        extensionOpts = moduleOptions.options.extensionOpts.default;
        piModules = [
          ./nix/modules/pi.nix
          ./nix/modules/analyzer.nix
          ./nix/modules/permission-gate.nix
          ./nix/modules/pi-extensions.nix
          ./nix/modules/committing-mode.nix
        ];
        # Models are host policy, so the outputs are built as a function of
        # them: the flake's own outputs use the registry defaults, while
        # consumers can build a configuration for their own model choices.
        mkConfig =
          {
            modules ? [ ],
            bashAltsOverride ? null,
            extensionOptsOverride ? null,
          }:
          (nixpkgs.lib.evalModules {
            modules = [
              moduleOptions
              {
                config = {
                  # mkDefault provides the registry values while allowing
                  # downstream modules to override individual options.
                  bashAlts = nixpkgs.lib.mkDefault (if bashAltsOverride == null then bashAlts else bashAltsOverride);
                  extensionOpts = nixpkgs.lib.mkDefault (
                    if extensionOptsOverride == null then extensionOpts else extensionOptsOverride
                  );
                };
              }
            ]
            ++ modules;
          }).config;
        mkResult =
          {
            models ? { },
            modules ? [ ],
            bashAlts ? null,
            extensionOpts ? null,
          }:
          let
            config = mkConfig {
              inherit modules;
              bashAltsOverride = bashAlts;
              extensionOptsOverride = extensionOpts;
            };
            moduleArgs = {
              inherit pkgs models;
              inherit (config) bashAlts extensionOpts;
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
                piModules;
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
          inherit bashAlts extensionOpts;

          agents =
            models:
            import ./nix/agents.nix {
              inherit (nixpkgs) lib;
              inherit models;
            };
          mkPi =
            {
              models ? { },
              modules ? [ ],
              bashAlts ? null,
              extensionOpts ? null,
            }:
            (mkResult {
              inherit
                models
                modules
                bashAlts
                extensionOpts
                ;
            }).packages.pi;
        };
      }
    );
}
