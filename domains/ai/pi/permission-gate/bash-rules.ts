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

export const normalizedCommandRule = (
  rules: BashRule[],
  argv: string[],
) => {
  const direct = rules.find((rule) => matchesBashRule(rule, argv));
  if (direct?.action !== "ask" || argv[0] !== "jj") return direct;
  const normalized = [...argv];
  while (
    normalized[0] === "jj" &&
    normalized.length > 1 &&
    /^(?:-R|--repository|--color)(?:=\S+)?$/.test(normalized[1])
  ) {
    normalized.splice(1, normalized[1].includes("=") ? 1 : 2);
  }
  while (["--no-graph", "--quiet", "--no-pager"].includes(normalized[1]))
    normalized.splice(1, 1);
  return rules.find((rule) => matchesBashRule(rule, normalized)) ?? direct;
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
  return commandArgv.map((argv) => {
    const head = argv[0]?.split("/").pop() || argv[0];
    return rules.find((rule) => {
      const pattern = rule.glob.trim().split(/\s+/);
      return rule.action === "deny" &&
        ((pattern.length === 1 && pattern[0] === head) ||
          (pattern.length === 2 && pattern[0] === head && pattern[1] === "*"));
    });
  }).find(Boolean);
};
