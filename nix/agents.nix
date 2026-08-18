# Agent registry. Prompt bodies live in ../agents/<name>.md; all harness- and
# policy-related metadata lives here so every consumer renders from one source.
#
#   mode         "primary" (a mode the human drives) | "subagent" (delegated)
#   model        null => harness default
#   tools        null => all default tools; [] => no tools at all
#   declaude     append the operator communication contract (default true)
#   permissions  argument-level bash and path rules shared by all harnesses
{
  lib,
  models ? { },
}:
let
  inherit (lib)
    mapAttrs
    filterAttrs
    concatStringsSep
    optionalString
    ;

  bodyDir = ../agents;
  wrapperText = builtins.readFile ../wrapper.md;
  declaudeText = builtins.readFile ../declaude.md;

  defaultModels = {
    cheap = "github-copilot/gpt-5.6-luna";
    expensive = "github-copilot/claude-opus-5";
  };
  mergedModels = defaultModels // models;

  # Harness-neutral capability names. Each harness maps them onto its own
  # tool/permission vocabulary.
  allCapabilities = [
    "read"
    "grep"
    "find"
    "ls"
    "bash"
    "edit"
    "write"
    "question"
  ];

  # pi has no `question` tool; everything else lines up 1:1.
  piToolName = {
    read = "read";
    grep = "grep";
    find = "find";
    ls = "ls";
    bash = "bash";
    edit = "edit";
    write = "write";
  };

  reviewLens = description: {
    inherit description;
    mode = "subagent";
    model = mergedModels.cheap;
    # Tier-1 review-heatmap lenses: cheap model, no tools at all — they must
    # judge only the chunk text handed to them, so any variance across them
    # reflects the lens, not extra context one happened to fetch.
    tools = [ ];
    declaude = false;
  };

  registry = {
    "context-preflight" = {
      description = "Build a bounded context package for an expensive subagent.";
      mode = "subagent";
      model = mergedModels.cheap;
      tools = [
        "read"
        "grep"
        "find"
        "ls"
      ];
    };

    "strategic-agent" = {
      description = "Perform a task using the selected context package.";
      mode = "subagent";
      model = mergedModels.expensive;
      # Read-only repository inspection is allowed; implementation remains the
      # caller's responsibility.
      tools = [
        "read"
        "grep"
        "find"
        "ls"
      ];
    };

    explore = {
      description = "Fast read-only codebase recon.";
      mode = "subagent";
      model = mergedModels.cheap;
      tools = [
        "read"
        "grep"
        "find"
        "ls"
      ];
      body = "";
    };

    implementer = {
      description = "Design an implementation from the task and return mergeable change proposals without modifying the repository.";
      mode = "subagent";
      model = mergedModels.expensive;
      tools = [
        "read"
        "grep"
        "find"
        "ls"
      ];
    };

    "draft-pr-notes" = {
      description = "Draft PR notes for the current change set, following the repo's PR template, and save to a temp file.";
      mode = "subagent";
    };

    "iterative-editor" = {
      description = "Tireless iterative content transformer.";
      mode = "primary";
      model = mergedModels.cheap;
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
      ];
      permissions = {
        bash = {
          "rg *" = "allow";
          "safe-fd *" = "allow";
          "ls *" = "allow";
          "*" = "deny";
        };
      };
    };

    "technical-voice" = {
      description = "Rewrite text in the operator's technical writing voice.";
      mode = "subagent";
      model = mergedModels.cheap;
    };

    "jj-change-describer" = {
      description = "Write a concise Jujutsu change description from a completed diff.";
      mode = "subagent";
      model = mergedModels.cheap;
      tools = [ ];
      declaude = false;
    };

    "cargo-dep-reader" = {
      description = "Answer questions about Rust dependencies from source already on disk.";
      mode = "subagent";
      model = mergedModels.cheap;
      tools = [
        "read"
        "grep"
        "find"
        "ls"
      ];
      permissions = {
        paths = {
          "*" = "deny";
          "~/.cargo/**" = "allow";
          "~/.rustup/**" = "allow";
        };
      };
    };

    "pr-aggregator" = {
      description = "Aggregates and reports on open PRs across the organization.";
      mode = "subagent";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
      ];
      permissions = {
        bash = {
          "gh search prs *" = "allow";
          "gh pr view *" = "allow";
          "*" = "deny";
        };
      };
    };

    "pr-chunker" = {
      description = "Analyze changed code chunks along Category, Leverage, and Scope axes and render a structured report.";
      mode = "subagent";
    };

    "review-heatmap" = {
      description = "v1 sanity-check for ensemble PR review — fan out cheap, tool-less lenses over changed chunks, measure variance against a self-noise floor, and render an attention heat map.";
      mode = "primary";
    };

    "review-lens-api" =
      reviewLens "Tier-1 review lens — scores chunks for API/interface design quality. No tools; judges only the text it's given.";
    "review-lens-empathy" =
      reviewLens "Tier-1 review lens — scores chunks for how hard they'll be for a human reviewer to correctly evaluate. No tools; judges only the text it's given.";
    "review-lens-idiom" =
      reviewLens "Tier-1 review lens — scores chunks for consistency with surrounding codebase idiom. No tools; judges only the text it's given.";
    "review-lens-perf" =
      reviewLens "Tier-1 review lens — scores chunks for locally-visible performance smells. No tools; judges only the text it's given.";
    "review-lens-security" =
      reviewLens "Tier-1 review lens — scores chunks for locally-visible security/data-exposure smells. No tools; judges only the text it's given.";

    "rubber-duck" = {
      description = "Rubber duck session — surface context, then ask one question at a time to help the user think through a problem before starting work.";
      mode = "primary";
      tools = allCapabilities;
      permissions = { };
    };
  };

  # Normalize: fill defaults, load the prompt body, build final instructions.
  normalize =
    name: raw:
    let
      body = raw.body or (builtins.readFile "${bodyDir}/${name}.md");
      declaude = raw.declaude or true;
      trimmed = lib.removeSuffix "\n" body;
    in
    {
      inherit name declaude;
      inherit (raw) description;
      mode = raw.mode or "subagent";
      model = raw.model or null;
      tools = raw.tools or null;
      permissions = raw.permissions or { };
      instructions =
        wrapperText
        + optionalString (trimmed != "") "\n\n${trimmed}"
        + optionalString declaude "\n\n${declaudeText}";
    };

  agents = mapAttrs normalize registry;

  byMode = mode: filterAttrs (_: a: a.mode == mode) agents;

  # pi has no notion of a "primary" agent, so those become prompt templates
  # (/name) while subagents become subagent definitions.
  yamlValue = builtins.toJSON;
  frontmatter =
    fields:
    let
      present = filterAttrs (_: v: v != null) fields;
    in
    "---\n"
    + concatStringsSep "\n" (lib.mapAttrsToList (k: v: "${k}: ${yamlValue v}") present)
    + "\n---\n\n";

  piAgentFile = agent: {
    name = "${agent.name}.md";
    value =
      frontmatter {
        inherit (agent) name description model;
        # The subagent extension is patched to read `none` as --no-tools.
        tools =
          if agent.tools == null then
            null
          else if agent.tools == [ ] then
            "none"
          else
            concatStringsSep ", " (
              lib.unique (lib.filter (t: t != null) (map (c: piToolName.${c} or null) agent.tools))
            );
      }
      + agent.instructions
      + "\n";
  };

  piPromptFile = agent: {
    name = "${agent.name}.md";
    value =
      frontmatter {
        inherit (agent) description;
        argument-hint = "[instructions]";
      }
      + agent.instructions
      + "\n\nUser request: $ARGUMENTS\n";
  };
in
{
  inherit agents allCapabilities;
  models = mergedModels;

  # name -> file contents, ready to be written into a configuration directory.
  piAgents = lib.mapAttrs' (_: piAgentFile) (byMode "subagent");
  piPrompts = lib.mapAttrs' (_: piPromptFile) (byMode "primary");
}
