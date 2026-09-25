{ lib, ... }:
let
  dependencyType = lib.types.either lib.types.str (
    lib.types.submodule {
      options = {
        name = lib.mkOption {
          type = lib.types.str;
          description = "Name of the required Pi extension.";
        };
        version = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Optional exact version pin for the required extension.";
        };
      };
    }
  );
  extensionDefaults = {
    permission-gate = {
      enable = true;
      dependsOn = [ ];
    };
    propose-permission = {
      enable = true;
      dependsOn = [ "permission-gate" ];
    };
    elements = {
      enable = true;
      dependsOn = [ ];
    };
    subagent = {
      enable = true;
      dependsOn = [ ];
    };
    committing-mode = {
      enable = true;
      dependsOn = [ ];
    };
    cost-status = {
      enable = true;
      dependsOn = [ ];
    };
    export-response = {
      enable = true;
      dependsOn = [ ];
    };
    sesseract = {
      enable = true;
      dependsOn = [ ];
    };
    mac-system-theme = {
      enable = true;
      dependsOn = [ ];
    };
    kagi-search = {
      enable = false;
      dependsOn = [ ];
    };
    fetch-webpage = {
      enable = true;
      dependsOn = [ ];
    };
    response-pipe = {
      enable = false;
      dependsOn = [ "permission-gate" ];
    };
  };
  extensionOption = defaults: {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = defaults.enable;
      description = "Whether to package and load this Pi extension.";
    };
    version = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = defaults.version or null;
      description = "Version provided by this extension, if it is versioned.";
    };
    dependsOn = lib.mkOption {
      type = lib.types.listOf dependencyType;
      default = defaults.dependsOn or [ ];
      description = "Extensions required when this extension is enabled.";
    };
  };
in
{
  imports = [ (lib.mkAliasOptionModule [ "extensionOpts" ] [ "extensions" ]) ];

  options.extensions = lib.mkOption {
    type = lib.types.submodule {
      # Keep bundled extensions explicit while allowing downstream flakes to
      # add their own named extensions (e.g. `pocket`).
      freeformType = lib.types.attrsOf (
        lib.types.submodule {
          options = extensionOption { enable = true; };
        }
      );
      options = lib.mapAttrs (_: extensionOption) extensionDefaults;
    };
    default = extensionDefaults;
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
