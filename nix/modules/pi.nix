{ pkgs, packages, ... }:
let
  piConfig = pkgs.stdenv.mkDerivation {
    pname = "pi-config";
    version = "1";
    dontUnpack = true;
    installPhase = ''
      mkdir -p "$out/agent/extensions" "$out/agent/agents" "$out/agent/prompts"
      ln -s ${../../domains/ai/permissions.json} "$out/agent/permissions.defaults.json"
      for agent in ${../../domains/ai/agents}/*.md; do
        ln -s "$agent" "$out/agent/agents/$(basename "$agent")"
        ln -s "$agent" "$out/agent/prompts/$(basename "$agent")"
      done
      for extension in ${../../domains/ai/pi}/*/; do
        name=$(basename "$extension")
        case "$name" in
          *.patch|*.test.ts) ;;
          *) ln -s "$extension" "$out/agent/extensions/$name" ;;
        esac
      done
    '';
  };
  upstreamPi = pkgs.callPackage ../../pkgs/pi { };
  pi = pkgs.writeShellApplication {
    name = "pi";
    runtimeInputs = [
      pkgs.coreutils
      upstreamPi
      packages.tree-sitter-bash-analyzer
    ];
    runtimeEnv.PI_CONFIG_SOURCE = "${piConfig}/agent";
    text = ''
      base="''${PI_CONFIG_DIR:?PI_CONFIG_DIR must be set}"
      agent="$base/agent"
      mkdir -p "$agent/extensions"
      ln -sfn "$PI_CONFIG_SOURCE/agents" "$agent/agents"
      ln -sfn "$PI_CONFIG_SOURCE/prompts" "$agent/prompts"
      ln -sfn "$PI_CONFIG_SOURCE/permissions.defaults.json" "$agent/permissions.defaults.json"
      for extension in "$PI_CONFIG_SOURCE/extensions"/*/; do
        name="$(basename "$extension")"
        ln -sfn "$extension" "$agent/extensions/$name"
      done
      export PI_CODING_AGENT_DIR="$agent"
      exec pi "$@"
    '';
  };
in
{
  packages = {
    inherit pi;
    default = pi;
  };
}
