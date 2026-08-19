{ lib, ... }:
{
  options.extensionOpts = lib.mkOption {
    type = lib.types.attrsOf (
      lib.types.submodule {
        options.enable = lib.mkOption {
          type = lib.types.bool;
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
    };
    description = "Pi extensions to package and load.";
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
