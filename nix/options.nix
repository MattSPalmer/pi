{ lib, ... }:
let
  extensionDefaults = {
    permission-gate = true;
    propose-permission = true;
    elements = true;
    subagent = true;
    committing-mode = true;
    cost-status = true;
    export-response = true;
    sesseract = true;
    mac-system-theme = true;
    kagi-search = false;
    fetch-webpage = true;
    response-pipe = false;
  };
  extensionOption = default: {
    enable = lib.mkOption {
      type = lib.types.bool;
      inherit default;
      description = "Whether to package and load this Pi extension.";
    };
  };
  extensionDefaultsConfig = lib.mapAttrs (_: enabled: { enable = enabled; }) extensionDefaults;
in
{
  imports = [ (lib.mkAliasOptionModule [ "extensionOpts" ] [ "extensions" ]) ];

  options.extensions = lib.mkOption {
    type = lib.types.submodule {
      # Keep extension options explicit for bundled extensions while allowing
      # downstream flakes to add their own named extensions (e.g. `pocket`).
      freeformType = lib.types.attrsOf (
        lib.types.submodule {
          options.enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Whether to package and load this Pi extension.";
          };
        }
      );
      options = lib.mapAttrs (_: extensionOption) extensionDefaults;
    };
    default = extensionDefaultsConfig;
    description = "Bundled and downstream Pi extensions to package and load.";
  };

  options.bashAlts = lib.mkOption {
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Whether to enforce this ALT preference and provide its replacement package.";
          };
          commands = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            description = "Commands that should be rejected in favor of this alternative.";
          };
          context = lib.mkOption {
            type = lib.types.str;
            description = "Explanation shown when an alternative command is requested.";
          };
          packages = lib.mkOption {
            type = lib.types.listOf lib.types.package;
            default = [ ];
            description = "Packages made available by this alternative.";
          };
        };
      }
    );
    default = { };
    description = "Bash command alternatives, with optional packages implied by each alternative.";
  };

  options.devShellPackages = lib.mkOption {
    type = lib.types.listOf lib.types.package;
    default = [ ];
    description = "Packages contributed by modules to the default development shell.";
  };
}
