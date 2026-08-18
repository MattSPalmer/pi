{ lib, ... }:
{
  options.altPreferences = lib.mkOption {
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
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
    description = "ALT command preferences, with optional packages implied by each preference.";
  };

  options.devShellPackages = lib.mkOption {
    type = lib.types.listOf lib.types.package;
    default = [ ];
    description = "Packages contributed by modules to the default development shell.";
  };
}
