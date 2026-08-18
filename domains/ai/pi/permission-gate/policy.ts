import { dirname, join, normalize } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export type Action = "allow" | "ask" | "deny";
export type Rule = { glob: string; action: Action; context?: string; source: string; tier: number; specificity: number };
const escapeRegex = (value: string) => value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
// Project policy is intentionally loaded at runtime: the same
// profile-managed extension can then be used from any repository.
// Policies live in .pi/permissions.json. Starting in a subdirectory
// loads that directory's ancestors from least to most specific, so
// a nearer file layers on top of (and can override) a higher-level
// file. The generated profile policy remains the lowest tier.
export const projectPolicyFiles = (cwd: string, home: string): string[] => {
  const files: string[] = [];
  const globalDefaults = join(
    home,
    ".pi",
    "agent",
    "permissions.defaults.json",
  );
  const globalOverrides = join(home, ".pi", "agent", "permissions.json");
  if (existsSync(globalDefaults)) files.push(globalDefaults);
  if (existsSync(globalOverrides)) files.push(globalOverrides);
  let current = normalize(cwd);
  while (true) {
    const file = join(current, ".pi", "permissions.json");
    if (existsSync(file)) files.unshift(file);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files;
};
export const projectRules = (cwd: string, axis: "bash" | "paths", home: string) => {
  const compiled: Rule[] = [];
  for (const [index, file] of projectPolicyFiles(cwd, home).entries()) {
    try {
      const policy = JSON.parse(readFileSync(file, "utf8")) as any;
      const sourceRules: Record<string, { action: Action; context?: string }> = {};
      if (axis === "bash") {
        if (
          policy.bash &&
          typeof policy.bash === "object" &&
          !Array.isArray(policy.bash)
        ) {
          for (const [glob, action] of Object.entries(policy.bash)) {
            if (typeof action === "string") {
              if (action === "allow" || action === "ask" || action === "deny")
                sourceRules[glob] = { action };
            } else if (action && typeof action === "object") {
              const configured = (action as any).action;
              if (
                (configured === "allow" || configured === "ask" || configured === "deny") &&
                ((action as any).context === undefined ||
                  typeof (action as any).context === "string")
              ) {
                sourceRules[glob] = {
                  action: configured,
                  context: (action as any).context,
                };
              }
            }
          }
        }
        // Make project permissions files use the same convenient
        // jj categories as the profile permissions.json.
        for (const category of [
          "DENY",
          "READ",
          "WRITE",
          "NETWORK",
          "ADMIN",
        ] as const) {
          const action: Action =
            category === "DENY"
              ? "deny"
              : category === "READ"
                ? "allow"
                : "ask";
          for (const item of policy.jj?.[category] ?? []) {
            const glob =
              typeof item === "string"
                ? `jj ${item}*`
                : `${item.externalShell}*`;
            if (typeof glob === "string") sourceRules[glob] = { action };
          }
        }
      } else {
        for (const path of policy.paths?.allow ?? [])
          sourceRules[path] = { action: "allow" };
        for (const path of policy.paths?.deny ?? [])
          sourceRules[path] = { action: "deny" };
      }
      for (const [glob, action] of Object.entries(sourceRules)) {
        const escaped = escapeRegex(glob);
        const bashTrailing = glob.endsWith("*");
        const bashBody = bashTrailing ? escaped.slice(0, -2) : escaped;
        const source =
          "^" +
          (axis === "paths"
            ? escaped.replace(/\\\*\\\*/g, ".*").replace(/\\\*/g, "[^/]*")
            : bashBody.replace(/\\\*/g, "[^\\s]*") +
              (bashTrailing ? ".*" : "")) +
          "$";
        compiled.push({
          glob,
          action: action.action,
          context: action.context,
          source,
          tier: index + 2,
          specificity: glob.replace(/\*/g, "").length,
        });
      }
    } catch (error) {
      // A malformed project policy must not disable the global gate.
      console.error(`permission-gate: ignoring ${file}: ${String(error)}`);
    }
  }
  return compiled;
};
export const activateProjectRules = (cwd: string, rules: { bash: Rule[]; paths: Rule[] }, home: string) => {
  const projectBash = projectRules(cwd, "bash", home).map((r) => ({ ...r, re: new RegExp(r.source.replace(/^\^~/, "^" + escapeRegex(home)), "s") }));
  const projectPaths = projectRules(cwd, "paths", home).map((r) => ({ ...r, re: new RegExp(r.source.replace(/^\^~/, "^" + escapeRegex(home)), "s") }));
  const bash = [...projectBash, ...rules.bash.map((r) => ({ ...r, re: new RegExp(r.source.replace(/^\^~/, "^" + escapeRegex(home)), "s") }))].sort(
    (a, b) => b.tier - a.tier || b.specificity - a.specificity,
  );
  const paths = [...projectPaths, ...rules.paths.map((r) => ({ ...r, re: new RegExp(r.source.replace(/^\^~/, "^" + escapeRegex(home)), "s") }))].sort(
    (a, b) => b.tier - a.tier || b.specificity - a.specificity,
  );
  return { bash, paths };
};
