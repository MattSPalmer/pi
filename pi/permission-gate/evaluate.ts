import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { realpathSync } from "node:fs";
import {
  activateProjectRules,
  type Rule,
} from "./policy";
import {
  deniedCommandRule,
  normalizedCommandRule,
  type BashRule,
} from "./bash-rules";
import {
  analyzeWithRust,
  opaqueShellCommands,
  type ShellAnalysis,
} from "./shell-analysis";

export type CompiledRule = Rule & { re: RegExp };
export interface PolicyRules {
  bash: CompiledRule[];
  paths: CompiledRule[];
}

export interface SessionGrants {
  bash: string[];
  paths: string[];
}

export type CommandClassification = {
  command: string;
  analysis?: ShellAnalysis;
  statements: string[];
  kind:
    | "allow"
    | "grant"
    | "ask"
    | "unrecognized"
    | "opaque"
    | "interpreter"
    | "deny";
  basis?: string;
  reason?: string;
  rule?: BashRule;
  interpreter?: string;
};

export type PathClassification =
  | { status: "allow"; candidates: string[] }
  | { status: "deny"; candidates: string[]; reason: string }
  | { status: "unknown"; candidates: string[]; displayPath: string };

export type AllowlistVerdict =
  | { verdict: "allow"; basis: string; command: string }
  | { verdict: "deny"; reason: string; command: string }
  | { verdict: "needs-confirmation"; reason: string; command: string };

const PATH_GRANT_ENTRY = "permission-gate-path-grant";
const sensitiveShellSyntax = /[;&|<>`()$]/;
const sensitiveReference = /(?:~\/\.ssh|\/\.ssh|AWS_|GPG_)/;

export const homeDirectory = (home = process.env.HOME || "~"): string => home;

export function loadPolicyRules(
  cwd: string,
  home = homeDirectory(),
): PolicyRules {
  return activateProjectRules(cwd, { bash: [], paths: [] }, home) as PolicyRules;
}

/** Recover persisted grants without depending on Pi's session implementation. */
export function sessionGrantsFromEntries(entries: Iterable<unknown>): SessionGrants {
  const grants: SessionGrants = { bash: [], paths: [] };
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (entry.type !== "custom" || entry.customType !== PATH_GRANT_ENTRY) continue;
    const data = entry.data;
    if (!data || typeof data !== "object") continue;
    const record = data as Record<string, unknown>;
    if (typeof record.path === "string") grants.paths.push(record.path);
    if (typeof record.command === "string" && record.command.length <= 4096) {
      grants.bash.push(record.command);
    }
  }
  return {
    bash: [...new Set(grants.bash)],
    paths: [...new Set(grants.paths)],
  };
}

export const expandHome = (value: string, home = homeDirectory()): string =>
  value.replace(/^~(?=\/|$)/, home);

/** Resolve existing path components before applying policy rules. */
export const canonicalPath = (value: string): string | undefined => {
  const missing: string[] = [];
  let current = normalize(value);
  while (true) {
    try {
      return normalize(join(realpathSync(current), ...missing));
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = dirname(current);
      if (parent === current) return normalize(value);
      missing.unshift(basename(current));
      current = parent;
    }
  }
};

export const isWithin = (path: string, folder: string): boolean =>
  folder === "/"
    ? path.startsWith("/")
    : path === folder || path.startsWith(folder + "/");

const unique = <T>(values: T[]): T[] => [...new Set(values)];

export function pathGrantRoots(
  pathRules: readonly CompiledRule[],
  home = homeDirectory(),
): string[] {
  return unique(
    pathRules
      .filter((rule) => rule.action === "allow")
      .map((rule) => {
        const glob = expandHome(rule.glob, home);
        const wildcard = glob.indexOf("*");
        if (wildcard < 0) return canonicalPath(normalize(glob)) ?? normalize(glob);
        const prefix = glob.slice(0, wildcard).replace(/\/+$/, "");
        if (!prefix) return undefined;
        const normalized = normalize(prefix);
        return canonicalPath(normalized) ?? normalized;
      })
      .filter((root): root is string => Boolean(root)),
  );
}

export function pathCandidates(
  value: string,
  cwd: string,
  pathRules: readonly CompiledRule[],
  sessionPathGrants: Iterable<string> = [],
  home = homeDirectory(),
): string[] {
  const expanded = expandHome(value, home);
  if (isAbsolute(expanded)) {
    const normalized = normalize(expanded);
    return [canonicalPath(normalized) ?? normalized];
  }

  const roots = unique([
    canonicalPath(normalize(cwd)) ?? normalize(cwd),
    ...[...sessionPathGrants].map((root) => canonicalPath(root) ?? root),
    ...pathGrantRoots(pathRules, home),
  ]);
  return unique(
    roots.flatMap((root) => {
      const lexical = normalize(resolve(root, expanded));
      const candidate = canonicalPath(lexical) ?? lexical;
      return isWithin(candidate, root) ? [candidate] : [];
    }),
  );
}

export function checkPathAgainstRules(
  value: string,
  cwd: string,
  pathRules: readonly CompiledRule[],
  sessionPathGrants: Iterable<string> = [],
  home = homeDirectory(),
): PathClassification {
  const candidates = pathCandidates(value, cwd, pathRules, sessionPathGrants, home);
  const grants = [...sessionPathGrants];
  const matches = candidates.map((candidate) => ({
    candidate,
    rule: pathRules.find((rule) => rule.re.test(candidate)),
    granted: grants.some((folder) =>
      isWithin(candidate, canonicalPath(folder) ?? normalize(folder)),
    ),
  }));
  const allowedByRule = matches.some(({ rule }) => rule?.action === "allow");
  const allowed = matches.some(
    ({ rule, granted }) => rule?.action === "allow" || granted,
  );
  const denied = matches.find(({ rule }) => rule?.action === "deny");
  if (denied && (isAbsolute(expandHome(value, home)) || !allowedByRule)) {
    return {
      status: "deny",
      candidates,
      reason: `Blocked by permission rule: ${denied.rule?.glob}${denied.rule?.context ? `\n${denied.rule.context}` : ""}`,
    };
  }
  if (allowed) return { status: "allow", candidates };
  return {
    status: "unknown",
    candidates,
    displayPath: candidates[0] || normalize(resolve(cwd, expandHome(value, home))),
  };
}

function commandGrant(
  grants: Iterable<string>,
  command: string,
  commandArgv: readonly string[][],
): string | undefined {
  // A command grant authorizes one parsed command invocation, not an entire
  // shell program. In particular, never let a grant for `tool *` authorize
  // `tool input; other-command` through a raw string prefix match.
  if (commandArgv.length !== 1) return undefined;
  for (const pattern of grants) {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    if (command === prefix || command.startsWith(prefix)) return pattern;
  }
  return undefined;
}

function normalizedCommand(command: string, cwd: string): string {
  const normalizedCwd = normalize(cwd);
  for (const prefix of [
    `cd ${normalizedCwd} && `,
    `cd '${normalizedCwd}' && `,
    `cd "${normalizedCwd}" && `,
  ]) {
    if (command.startsWith(prefix)) return command.slice(prefix.length);
  }
  return command || "true";
}

export function classifyCommand(options: {
  command: string;
  cwd: string;
  bashRules: readonly CompiledRule[];
  sessionBashGrants?: Iterable<string>;
}): CommandClassification {
  const command = normalizedCommand(options.command.trim(), options.cwd);
  if (sensitiveShellSyntax.test(command) && sensitiveReference.test(command)) {
    return {
      command,
      kind: "deny",
      statements: [],
      reason: "Blocked: shell command cannot be statically analyzed because it references a sensitive path",
    };
  }

  const analysis = analyzeWithRust(command);
  if (!analysis.safe) {
    return {
      command,
      analysis,
      kind: "opaque",
      statements: [],
      reason: analysis.reason,
    };
  }

  const interpreter = analysis.heads.find((head) => opaqueShellCommands.has(head));
  if (interpreter) {
    return {
      command,
      analysis,
      kind: "interpreter",
      statements: analysis.commands,
      interpreter,
      reason: `opaque interpreter (${interpreter})`,
    };
  }

  const commandRules = analysis.commandArgv.map((argv) =>
    normalizedCommandRule(options.bashRules as BashRule[], argv),
  );
  const denied = deniedCommandRule(
    options.bashRules as BashRule[],
    analysis.commandArgv,
  );
  if (denied) {
    return {
      command,
      analysis,
      kind: "deny",
      statements: analysis.commands,
      rule: denied,
      reason: `Blocked by permission rule: ${denied.glob}${denied.context ? `\n${denied.context}` : ""}`,
    };
  }

  const grant = commandGrant(
    options.sessionBashGrants ?? [],
    command,
    analysis.commandArgv,
  );
  if (grant) {
    return {
      command,
      analysis,
      kind: "grant",
      statements: analysis.commands,
      basis: `session grant ${grant}`,
    };
  }

  const asking = commandRules.find((rule) => rule?.action === "ask");
  if (asking) {
    return {
      command,
      analysis,
      kind: "ask",
      statements: analysis.commands,
      rule: asking,
      basis: asking.glob,
      reason: `permission rule ${asking.glob} requires approval`,
    };
  }

  if (commandRules.some((rule) => !rule)) {
    return {
      command,
      analysis,
      kind: "unrecognized",
      statements: analysis.commands,
      reason: "unrecognized shell command",
    };
  }

  const allowRules = commandRules.filter((rule) => rule?.action === "allow");
  return {
    command,
    analysis,
    kind: "allow",
    statements: analysis.commands,
    basis: allowRules.map((rule) => rule!.glob).join(", "),
  };
}

/**
 * Evaluate only the non-interactive policy decision. A consumer can map
 * `needs-confirmation` to its own UI; this module never assumes Pi exists.
 */
export function evaluateAllowlist(options: {
  command: string;
  cwd: string;
  rules: PolicyRules;
  grants?: SessionGrants;
}): AllowlistVerdict {
  const classification = classifyCommand({
    command: options.command,
    cwd: options.cwd,
    bashRules: options.rules.bash,
    sessionBashGrants: options.grants?.bash,
  });
  if (classification.kind === "deny") {
    return {
      verdict: "deny",
      reason: classification.reason ?? "Blocked by permission policy",
      command: classification.command,
    };
  }
  if (classification.kind === "opaque" || classification.kind === "interpreter") {
    return {
      verdict: "needs-confirmation",
      reason: classification.reason ?? "Shell syntax requires approval",
      command: classification.command,
    };
  }

  for (const path of [
    ...(classification.analysis?.paths ?? []),
    ...(classification.analysis?.redirects ?? []),
  ]) {
    const pathResult = checkPathAgainstRules(
      path,
      options.cwd,
      options.rules.paths,
      options.grants?.paths,
    );
    if (pathResult.status === "deny") {
      return {
        verdict: "deny",
        reason: pathResult.reason,
        command: classification.command,
      };
    }
    if (pathResult.status === "unknown") {
      return {
        verdict: "needs-confirmation",
        reason: `path approval (${pathResult.displayPath})`,
        command: classification.command,
      };
    }
  }

  if (classification.kind === "allow" || classification.kind === "grant") {
    return {
      verdict: "allow",
      basis: classification.basis ?? "permission policy",
      command: classification.command,
    };
  }
  return {
    verdict: "needs-confirmation",
    reason: classification.reason ?? "command is not allowlisted",
    command: classification.command,
  };
}
