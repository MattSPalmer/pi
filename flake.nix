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
        bashAlts = {
          git = mkAlt [ "git" "git *" "*/git" "*/git *" ] "jj" [ pkgs.jujutsu ];
          find = mkAlt [ "find" "find *" ] "fd" [ pkgs.fd ];
          grep = mkAlt [ "grep" "grep *" ] "rg" [ pkgs.ripgrep ];
        };
        moduleOptions = import ./nix/options.nix {
          inherit (nixpkgs) lib;
          inherit system;
        };
        extensions = moduleOptions.options.extensions.default;
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
            extensionsOverride ? null,
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
                  extensions = nixpkgs.lib.mkDefault (
                    if extensionsOverride != null then
                      extensionsOverride
                    else if extensionOptsOverride != null then
                      extensionOptsOverride
                    else
                      extensions
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
            piPackage ? null,
            bashAlts ? null,
            extensions ? null,
            extensionOpts ? null,
          }:
          let
            config = mkConfig {
              inherit modules;
              bashAltsOverride = bashAlts;
              extensionsOverride = extensions;
              extensionOptsOverride = extensionOpts;
            };
            moduleArgs = {
              inherit pkgs models piPackage;
              inherit (config) bashAlts extensions;
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
        piWithRequiredExtension =
          (mkResult {
            modules = [
              {
                extensions.permission-gate.enable = false;
                extensions.propose-permission.enable = true;
              }
            ];
          }).packages.pi;
      in
      (nixpkgs.lib.removeAttrs result [ "devShellPackages" ])
      // {
        checks = result.checks // {
          extensionDependencies = pkgs.runCommand "pi-extension-dependencies-test" { } ''
            test -e ${piWithRequiredExtension}/agent/extensions/permission-gate/index.ts
            test -e ${piWithRequiredExtension}/agent/extensions/propose-permission/index.ts
            touch "$out"
          '';
          subagentContext = pkgs.runCommand "pi-subagent-context-test" { } ''
            set -eu
            extension=${result.packages.pi}/agent/extensions/subagent
            test -e "$extension/index.ts"
            test -e "$extension/agents.ts"

            # Metadata parsing and automatic context injection must be present
            # in the patched extension, not merely in the source patch.
            grep -q 'contextFile?: string' "$extension/agents.ts"
            grep -q 'frontmatter.contextFile' "$extension/agents.ts"
            grep -q 'fs.readFileSync(agent.contextFile' "$extension/index.ts"
            grep -q 'Injected context from' "$extension/index.ts"
            grep -q 'Could not read context file' "$extension/index.ts"

            # Generated review lenses must opt into injection while remaining
            # explicitly tool-less; unrelated agents must not inherit it.
            for lens in api empathy idiom perf security; do
              file=${result.packages.pi}/agent/agents/review-lens-$lens.md
              grep -q 'contextFile: "/tmp/pr-chunks-normalized.json"' "$file"
              grep -q 'tools: "none"' "$file"
            done
            ! grep -R -q 'contextFile:' ${result.packages.pi}/agent/agents/context-preflight.md
            touch "$out"
          '';
        };

        devShells.default = pkgs.mkShell {
          packages = nixpkgs.lib.unique result.devShellPackages;
        };

        # Consumers (other harnesses, other hosts) build from the same registry
        # and the same packaged configuration.
        lib = {
          # Expose the option defaults so downstream flakes can extend or
          # override the shared command alternatives and extension selection.
          inherit bashAlts extensions;
          # Backward-compatible alias; prefer `extensions.<name>.enable`.
          extensionOpts = extensions;

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
              piPackage ? null,
              bashAlts ? null,
              extensions ? null,
              extensionOpts ? null,
            }:
            (mkResult {
              inherit
                models
                modules
                piPackage
                bashAlts
                extensions
                extensionOpts
                ;
            }).packages.pi;
        };
      }
    );
}
