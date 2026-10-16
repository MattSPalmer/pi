{
  pkgs,
  packages,
  bashAlts,
  models,
  piPackage ? null,
  extensions,
  ...
}:
let
  agents = import ../agents.nix {
    inherit (pkgs) lib;
    inherit models;
  };
  writeMarkdown =
    name: files:
    pkgs.linkFarm name (
      pkgs.lib.mapAttrsToList (file: text: {
        name = file;
        path = pkgs.writeText file text;
      }) files
    );
  agentFiles = writeMarkdown "pi-agents" agents.piAgents;
  promptFiles = writeMarkdown "pi-prompts" agents.piPrompts;
  permissionFiles = pkgs.linkFarm "pi-agent-permissions" (
    pkgs.lib.mapAttrsToList (name: agent: {
      name = "${name}.json";
      path = pkgs.writeText "${name}-permissions.json" (builtins.toJSON agent.permissions);
    }) agents.agents
  );
  basePermissions = builtins.fromJSON (builtins.readFile ../../permissions.json);
  enabledAltPreferences = pkgs.lib.filterAttrs (_: alt: alt.enable or false) bashAlts;
  extensionDependencies =
    extension:
    map (
      dependency:
      if builtins.isString dependency then
        {
          name = dependency;
          version = null;
        }
      else
        dependency
    ) (extension.dependsOn or [ ]);
  resolveExtensionDependencies =
    enabled:
    let
      dependencies = builtins.concatMap (
        name:
        map (dependency: dependency // { requiredBy = name; }) (extensionDependencies extensions.${name})
      ) (pkgs.lib.attrNames enabled);
      missing = builtins.filter (dependency: !(builtins.hasAttr dependency.name extensions)) dependencies;
      versionMismatches = builtins.filter (
        dependency:
        builtins.hasAttr dependency.name extensions
        && dependency.version != null
        && (extensions.${dependency.name}.version or null) != dependency.version
      ) dependencies;
      next = builtins.foldl' (
        selected: dependency: selected // { ${dependency.name} = extensions.${dependency.name}; }
      ) enabled dependencies;
    in
    if missing != [ ] then
      let
        dependency = builtins.head missing;
      in
      throw "Pi extension '${dependency.requiredBy}' depends on unknown extension '${dependency.name}'"
    else if versionMismatches != [ ] then
      let
        dependency = builtins.head versionMismatches;
      in
      throw "Pi extension '${dependency.requiredBy}' requires ${dependency.name} version '${dependency.version}', but the configured version is '${
        extensions.${dependency.name}.version or "unspecified"
      }'"
    else if pkgs.lib.attrNames next == pkgs.lib.attrNames enabled then
      enabled
    else
      resolveExtensionDependencies next;
  enabledExtensionSet = resolveExtensionDependencies (
    pkgs.lib.filterAttrs (_: extension: extension.enable or false) extensions
  );
  enabledExtensions = pkgs.lib.attrNames enabledExtensionSet;
  fetchWebpageEnabled = enabledExtensionSet.fetch-webpage.enable or false;
  altRules = builtins.concatLists (
    pkgs.lib.mapAttrsToList (
      _: alt:
      map (command: {
        inherit command;
        context = alt.context;
      }) alt.commands
    ) enabledAltPreferences
  );
  permissions = basePermissions // {
    bash = basePermissions.bash // {
      ALT = altRules;
    };
  };
  permissionsFile = pkgs.writeText "permissions.defaults.json" (builtins.toJSON permissions);
  altInstructions = pkgs.writeText "bash-alt-instructions.md" (
    if altRules == [ ] then
      ""
    else
      "\n\nBash command alternatives (ALT rules):\n"
      + pkgs.lib.concatMapStrings (rule: "- Do not use `${rule.command}`; ${rule.context}\n") altRules
  );
  altPackages = pkgs.lib.concatLists (
    pkgs.lib.mapAttrsToList (_: alt: alt.packages or [ ]) enabledAltPreferences
  );
  piConfig = pkgs.stdenv.mkDerivation {
    pname = "pi-config";
    version = "1";
    dontUnpack = true;
    installPhase = ''
      mkdir -p "$out/agent/extensions"
      ln -s ${permissionsFile} "$out/agent/permissions.defaults.json"
      # Subagent definitions and prompt templates are rendered from the shared
      # registry: subagents carry name/model/tools frontmatter, prompts carry
      # the argument hint.
      ln -s ${agentFiles} "$out/agent/agents"
      ln -s ${promptFiles} "$out/agent/prompts"
      ln -s ${permissionFiles} "$out/agent/permissions"
      for extension in ${../../pi}/*/; do
        name=$(basename "$extension")
        case "$name" in
          *.patch|*.test.ts) ;;
          *)
            case " ${builtins.concatStringsSep " " enabledExtensions} " in
              *" $name "*) ln -s "$extension" "$out/agent/extensions/$name" ;;
            esac
            ;;
        esac
      done
      if ${if enabledExtensionSet.subagent.enable or false then "true" else "false"}; then
        ln -s ${subagentExtension} "$out/agent/extensions/subagent"
      fi
    '';
  };
  upstreamPi = if piPackage != null then piPackage else pkgs.callPackage ../../pkgs/pi { };
  # The upstream subagent example is the basis for delegated agents. Patch it
  # so `tools: none` disables tools, subagents are identifiable at runtime, and
  # agent definitions are read from the packaged configuration rather than from
  # the writable user directory.
  subagentExtension = pkgs.runCommand "pi-subagent-extension" { nativeBuildInputs = [ pkgs.bun ]; } ''
    mkdir -p $out
    cp ${upstreamPi}/bin/examples/extensions/subagent/{index.ts,agents.ts} $out/
    cp ${../../pi/subagent-context.mjs} $out/subagent-context.mjs
    chmod +w $out/index.ts $out/agents.ts
    patch --fuzz=0 -p1 -d $out < ${../../pi/subagent.patch}
    substituteInPlace $out/agents.ts \
      --replace-fail 'const userDir = path.join(getAgentDir(), "agents");' \
      'const userDir = process.env.PI_CONFIG_DIR ? path.join(process.env.PI_CONFIG_DIR, "agents") : path.join(getAgentDir(), "agents");'

    # Parse the patched module graph, including agents.ts. A successful patch
    # or a text-presence check alone does not guarantee loadable TypeScript.
    bun build "$out/index.ts" --bundle --format=esm --target=bun \
      --external='@earendil-works/*' --external=typebox \
      --outfile "$TMPDIR/subagent-validation.js"
  '';
  piWrapper = pkgs.writeShellApplication {
    name = "pi";
    runtimeInputs = [
      pkgs.coreutils
      upstreamPi
      packages.tree-sitter-bash-analyzer
    ]
    ++ altPackages
    ++ pkgs.lib.optionals fetchWebpageEnabled [ pkgs.curl ];
    runtimeEnv = {
      PI_CONFIG_DIR = "${piConfig}/agent";
      PI_BASH_ALT_INSTRUCTIONS = "${altInstructions}";
    }
    // pkgs.lib.optionalAttrs fetchWebpageEnabled {
      PI_FETCH_WEBPAGE_CURL = "${pkgs.curl}/bin/curl";
    };
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
