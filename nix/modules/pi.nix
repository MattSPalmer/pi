{
  pkgs,
  packages,
  altPreferences,
  ...
}:
let
  basePermissions = builtins.fromJSON (builtins.readFile ../../permissions.json);
  altRules = builtins.concatLists (
    pkgs.lib.mapAttrsToList (
      _: alt:
      map (command: {
        inherit command;
        context = alt.context;
      }) alt.commands
    ) altPreferences
  );
  permissions = basePermissions // {
    bash = basePermissions.bash // {
      ALT = altRules;
    };
  };
  permissionsFile = pkgs.writeText "permissions.defaults.json" (builtins.toJSON permissions);
  altPackages = pkgs.lib.concatLists (
    pkgs.lib.mapAttrsToList (_: alt: alt.packages or [ ]) altPreferences
  );
  piConfig = pkgs.stdenv.mkDerivation {
    pname = "pi-config";
    version = "1";
    dontUnpack = true;
    installPhase = ''
      mkdir -p "$out/agent/extensions" "$out/agent/agents" "$out/agent/prompts"
      ln -s ${permissionsFile} "$out/agent/permissions.defaults.json"
      for agent in ${../../agents}/*.md; do
        ln -s "$agent" "$out/agent/agents/$(basename "$agent")"
        ln -s "$agent" "$out/agent/prompts/$(basename "$agent")"
      done
      for extension in ${../../pi}/*/; do
        name=$(basename "$extension")
        case "$name" in
          *.patch|*.test.ts) ;;
          *) ln -s "$extension" "$out/agent/extensions/$name" ;;
        esac
      done
      ln -s ${subagentExtension} "$out/agent/extensions/subagent"
    '';
  };
  upstreamPi = pkgs.callPackage ../../pkgs/pi { };
  # The upstream subagent example is the basis for delegated agents. Patch it
  # so `tools: none` disables tools, subagents are identifiable at runtime, and
  # agent definitions are read from the packaged configuration rather than from
  # the writable user directory.
  subagentExtension = pkgs.runCommand "pi-subagent-extension" { } ''
    mkdir -p $out
    cp ${upstreamPi}/bin/examples/extensions/subagent/{index.ts,agents.ts} $out/
    chmod +w $out/index.ts $out/agents.ts
    patch -p1 -d $out < ${../../pi/subagent.patch}
    substituteInPlace $out/agents.ts \
      --replace-fail 'const userDir = path.join(getAgentDir(), "agents");' \
      'const userDir = process.env.PI_CONFIG_DIR ? path.join(process.env.PI_CONFIG_DIR, "agents") : path.join(getAgentDir(), "agents");'
  '';
  piWrapper = pkgs.writeShellApplication {
    name = "pi";
    runtimeInputs = [
      pkgs.coreutils
      upstreamPi
      packages.tree-sitter-bash-analyzer
    ]
    ++ altPackages;
    runtimeEnv.PI_CONFIG_DIR = "${piConfig}/agent";
    text = ''
      # PI_CONFIG_DIR identifies the immutable packaged configuration, which is
      # loaded straight from the store. Nothing is copied or linked into the
      # user's directory; that directory holds writable Pi state only
      # (credentials, settings, sessions).
      config="$PI_CONFIG_DIR"
      resources=()
      for extension in "$config/extensions"/*/; do
        [ -e "$extension/index.ts" ] || [ -e "$extension/index.js" ] || continue
        resources+=(--extension "$extension")
      done
      if [ -d "$config/prompts" ]; then
        resources+=(--prompt-template "$config/prompts")
      fi
      if [ -n "''${PI_AGENT_DIR:-}" ]; then
        export PI_CODING_AGENT_DIR="$PI_AGENT_DIR"
      fi
      exec pi "''${resources[@]}" "$@"
    '';
  };
  # Keep the generated configuration alongside the executable in the build
  # result, rather than only referring to it through the store path at runtime.
  pi = pkgs.symlinkJoin {
    name = "pi";
    paths = [
      piWrapper
      piConfig
    ];
  };
in
{
  packages = {
    inherit pi;
    default = pi;
  };
  devShellPackages = altPackages;
}
