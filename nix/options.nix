{ lib, ... }:
let
  inherit (lib) mkOption types;
  permissionCategories = [
    "DENY"
    "ALT"
    "READ"
    "WRITE"
    "NETWORK"
    "ADMIN"
  ];
  permissionSectionType = types.submodule {
    options = lib.genAttrs permissionCategories (
      _:
      mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Command patterns in this permission category.";
      }
    );
  };
  permissionFragmentType = types.submodule {
    options = {
      bash = mkOption {
        type = permissionSectionType;
        default = { };
        description = "Top-level shell command permissions contributed by this alternative.";
      };
      paths = mkOption {
        type = permissionSectionType;
        default = { };
        description = "Path permissions contributed by this alternative.";
      };
      commands = mkOption {
        type = types.attrsOf permissionSectionType;
        default = { };
        description = "Namespaced command permissions, keyed by executable name.";
      };
    };
  };
in
{
  options.extensionOpts = mkOption {
    type = types.attrsOf (
      types.submodule {
        options.enable = mkOption {
          type = types.bool;
          default = true;
          description = "Whether to package this Pi extension.";
        };
      }
    );
    default = {
      permission-gate.enable = true;
      propose-permission.enable = true;
      elements.enable = true;
      subagent.enable = true;
      committing-mode.enable = true;
      cost-status.enable = true;
      export-response.enable = true;
      sesseract.enable = true;
      kagi-search.enable = false;
      response-pipe.enable = false;
      response-scroll.enable = true;
      # TODO: Re-enable once Pi's Bun-compiled extension loader handles jiti's
      # data: URLs without triggering NameTooLong during extension resolution.
      session-report.enable = false;
    };
    description = "Pi extensions to package and load.";
  };

  options.bashAlts = mkOption {
    type = types.attrsOf (
      types.submodule {
        options = {
          enable = mkOption {
            type = types.bool;
            default = false;
            description = "Whether to replace the displaced command and activate its replacement policy.";
          };
          displace = mkOption {
            type = types.nonEmptyListOf types.str;
            description = "Command patterns rejected in favor of the replacement.";
          };
          replacement = mkOption {
            type = types.nonEmptyStr;
            description = "Replacement command presented to the user.";
          };
          context = mkOption {
            type = types.nonEmptyStr;
            description = "Explanation shown when a displaced command is requested.";
          };
          packages = mkOption {
            type = types.listOf types.package;
            default = [ ];
            description = "Packages that provide the replacement command and its helpers.";
          };
          permissions = mkOption {
            type = permissionFragmentType;
            default = { };
            description = "Permissions activated with the replacement command.";
          };
        };
      }
    );
    default = { };
    description = "Declarative command replacements: deny the old command, install the replacement, and activate its policy as one unit.";
  };

  options.devShellPackages = mkOption {
    type = types.listOf types.package;
    default = [ ];
    description = "Packages contributed by modules to the default development shell.";
  };
}
