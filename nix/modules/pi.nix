{ pkgs, ... }:
let
  piConfig = pkgs.runCommand "pi-config" { } ''
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
  upstreamPi = pkgs.callPackage ../../pkgs/pi { };
  pi = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    base="''${PI_CONFIG_DIR:?PI_CONFIG_DIR must be set}"
    agent="$base/agent"
    mkdir -p "$agent/extensions"
    rm -rf "$agent/extensions/pocket" "$agent/extensions/agentic-20-questions.ts"
    ln -sfn ${piConfig}/agent/agents "$agent/agents"
    ln -sfn ${piConfig}/agent/prompts "$agent/prompts"
    ln -sfn ${piConfig}/agent/permissions.defaults.json "$agent/permissions.defaults.json"
    for extension in ${piConfig}/agent/extensions/*/; do
      name="$(basename "$extension")"
      ln -sfn "$extension" "$agent/extensions/$name"
    done
    export PI_CODING_AGENT_DIR="$agent"
    exec ${upstreamPi}/bin/pi "$@"
  '';
in
{
  packages = {
    inherit piConfig pi;
    default = pkgs.symlinkJoin {
      name = "pi-harness";
      paths = [
        pi
        piConfig
      ];
      meta.mainProgram = "pi";
    };
  };
}
