{ lib, ... }:
{
  options.devShellPackages = lib.mkOption {
    type = lib.types.listOf lib.types.package;
    default = [ ];
    description = "Packages contributed by modules to the default development shell.";
  };
}
