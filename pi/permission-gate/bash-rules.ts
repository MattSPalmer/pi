export type BashRule = {
  glob: string;
  action: "allow" | "ask" | "deny";
  context?: string;
};

export const matchesBashRule = (rule: BashRule, argv: string[]) => {
  const pattern = rule.glob.trim().split(/\s+/);
  if (!pattern.length || argv.length < pattern.length) return false;
  const last = pattern.length - 1;
  for (let index = 0; index < pattern.length; index++) {
    const token = pattern[index];
    const wildcard = token.endsWith("*");
    const prefix = wildcard ? token.slice(0, -1) : token;
    if (!argv[index].startsWith(prefix)) return false;
    if (!wildcard && argv[index] !== token) return false;
    if (wildcard && index === last) return true;
  }
  return argv.length === pattern.length;
};

// Policy rules describe a jj subcommand, while jj permits global options both
// before it and between `jj` and the subcommand. Canonicalize that argv shape
// before *every* policy lookup; this must not depend on the action of a
// coincidental raw-argv match.
export const normalizeJjArgv = (argv: readonly string[]): string[] => {
  if (argv[0] !== "jj") return [...argv];
  const normalized = [...argv];
  while (
    normalized.length > 1 &&
    /^(?:-R|--repository|--color)(?:=\S+)?$/.test(normalized[1])
  ) {
    normalized.splice(1, normalized[1].includes("=") ? 1 : 2);
  }
  while (["--no-graph", "--quiet", "--no-pager"].includes(normalized[1]))
    normalized.splice(1, 1);
  return normalized;
};

export const normalizedCommandRule = (rules: BashRule[], argv: string[]) => {
  const normalized = normalizeJjArgv(argv);
  // Prefer an exact raw rule when one exists, so a policy can intentionally
  // constrain a particular global-option spelling. Otherwise use the
  // canonical jj invocation used by the categorized jj policy.
  return (
    rules.find((rule) => matchesBashRule(rule, argv)) ??
    rules.find((rule) => matchesBashRule(rule, normalized))
  );
};

export const deniedCommandRule = (
  rules: BashRule[],
  commandArgv: string[][],
) => {
  const direct = commandArgv
    .map((argv) => normalizedCommandRule(rules, argv))
    .find((rule) => rule?.action === "deny");
  if (direct) return direct;
  // Defensive head-level fallback: deny `tool` and `tool *` even if an
  // analyzer supplies an unusual argv shape for a compound statement.
  return commandArgv
    .map((argv) => {
      const head = argv[0]?.split("/").pop() || argv[0];
      return rules.find((rule) => {
        const pattern = rule.glob.trim().split(/\s+/);
        return (
          rule.action === "deny" &&
          ((pattern.length === 1 && pattern[0] === head) ||
            (pattern.length === 2 && pattern[0] === head && pattern[1] === "*"))
        );
      });
    })
    .find(Boolean);
};
