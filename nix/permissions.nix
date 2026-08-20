{ lib }:
let
  categories = [
    "DENY"
    "ALT"
    "READ"
    "WRITE"
    "NETWORK"
    "ADMIN"
  ];

  emptySection = lib.genAttrs categories (_: [ ]);
  normalizeSection = section: emptySection // section;

  mergeSection =
    left: right:
    lib.genAttrs categories (
      category: lib.unique ((left.${category} or [ ]) ++ (right.${category} or [ ]))
    );

  normalize = policy: {
    bash = normalizeSection (policy.bash or { });
    paths = normalizeSection (policy.paths or { });
    commands = lib.mapAttrs (_: normalizeSection) (
      (builtins.removeAttrs policy [
        "bash"
        "paths"
        "commands"
      ])
      // (policy.commands or { })
    );
  };

  merge =
    left: right:
    let
      a = normalize left;
      b = normalize right;
      commandNames = lib.unique (builtins.attrNames a.commands ++ builtins.attrNames b.commands);
    in
    {
      bash = mergeSection a.bash b.bash;
      paths = mergeSection a.paths b.paths;
      commands = lib.genAttrs commandNames (
        name: mergeSection (a.commands.${name} or { }) (b.commands.${name} or { })
      );
    };

  pruneSection = section: lib.filterAttrs (_: entries: entries != [ ]) section;

  render =
    policy:
    let
      normalized = normalize policy;
      bash = pruneSection normalized.bash;
      paths = pruneSection normalized.paths;
      commands = lib.filterAttrs (_: section: section != { }) (
        lib.mapAttrs (_: pruneSection) normalized.commands
      );
    in
    lib.optionalAttrs (bash != { }) { inherit bash; }
    // lib.optionalAttrs (paths != { }) { inherit paths; }
    // lib.optionalAttrs (commands != { }) { inherit commands; };

  altFragment = alt: {
    bash.ALT = map (command: {
      inherit command;
      inherit (alt) context;
    }) alt.displace;
  };
in
{
  inherit
    altFragment
    categories
    merge
    normalize
    render
    ;

  mergeAll = builtins.foldl' merge { };
}
