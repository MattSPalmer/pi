import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { normalize } from "node:path";

import {
  auditStates,
  markPrompt,
  recordPermissionRequest,
  type AuditState,
} from "./audit";
import { askBash, type StatementAnnotation } from "./prompts";
import { activateProjectRules } from "./policy";
import { looksLikePath, rustAnalyzer } from "./shell-analysis";
import {
  canonicalPath,
  checkPathAgainstRules,
  classifyCommand,
  expandHome,
  pathGrantRoots,
  type CompiledRule,
} from "./evaluate";

// Global defaults and user overrides are loaded from disk at runtime.
const RULES: Record<string, { bash: CompiledRule[]; paths: CompiledRule[] }> = {
  "": { bash: [], paths: [] },
};
const home = process.env.HOME || "~";

const scope = process.env.PI_SUBAGENT_NAME || "";
const rules = RULES[scope] || RULES[""];
let bashRules = rules.bash;
let pathRules = rules.paths;
let initializedCwd: string | undefined;

// `session_start` normally initializes the active policy, but a tool call can
// arrive before that hook when an extension is loaded into an already-running
// session (or during startup races). Apply the configured defaults lazily too.
const initializeForCwd = (cwd: string) => {
  if (initializedCwd === cwd) return;
  ({ bash: bashRules, paths: pathRules } = activateProjectRules(cwd, rules, home));
  initializedCwd = cwd;
};

const sessionPathGrants = new Set<string>();
const sessionBashGrants = new Set<string>();
const PATH_GRANT_ENTRY = "permission-gate-path-grant";
const restoreSessionGrants = (ctx: any) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== PATH_GRANT_ENTRY)
      continue;
    const data = (entry as any).data;
    if (data && typeof data.path === "string") rememberSessionPath(data.path);
    if (data && typeof data.command === "string" && data.command.length <= 4096)
      sessionBashGrants.add(data.command);
  }
};
const rememberSessionPath = (folder: string, pi?: ExtensionAPI) => {
  const normalized = canonicalPath(normalize(folder)) ?? normalize(folder);
  if (sessionPathGrants.has(normalized)) return;
  sessionPathGrants.add(normalized);
  pi?.appendEntry(PATH_GRANT_ENTRY, { path: normalized });
};
const parentFolder = (value: string) => {
  const normalized = value.replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : normalized;
};

const commandAnnotations = (classification: any): StatementAnnotation[] | undefined => {
  const statements = classification.statements as string[];
  const analysis = classification.analysis;
  if (!statements?.length) return undefined;
  return statements.map((statement, index) => {
    const problems: string[] = [];
    if (classification.kind === "unrecognized") problems.push("command is not allowlisted");
    if (classification.kind === "interpreter" || classification.kind === "opaque") problems.push("opaque command syntax");
    if (classification.rule?.glob) problems.push(`arg pattern: ${classification.rule.glob}`);
    const argv = analysis?.commandArgv?.[index] ?? [];
    const paths = new Set([
      ...(analysis?.paths ?? []),
      ...(analysis?.redirects ?? []),
    ]);
    for (const path of paths) {
      if (looksLikePath(path) && argv.includes(path)) problems.push(`path: ${path}`);
    }
    return { statement, problems };
  });
};

const MAX_PATH_LENGTH = 4096;
const MAX_PATH_SEGMENTS = 64;
const choosePath = async (
  ctx: any,
  value: string,
): Promise<string | undefined> => {
  // A path grant must be backed by an existing filesystem path.  Do
  // this in the Rust validator so regexes and stream ranges cannot
  // be mistaken for paths.  The validator deliberately exposes only
  // a boolean, avoiding malformed-vs-missing path disclosure.
  const normalizedValue = canonicalPath(normalize(value)) ?? normalize(value);
  // When an existing allow rule supplies a filesystem root, validate
  // against that canonical root as well as checking existence. This
  // prevents an existing path (including one reached through a
  // symlink) from escaping the policy root. With no matching policy
  // root, an interactive approval may still establish a new scope.
  const policyRoots = pathGrantRoots(pathRules, home).filter((root) =>
    normalizedValue === root || normalizedValue.startsWith(root + "/"),
  );
  const rootsToCheck = policyRoots.length ? policyRoots : [undefined];
  let validPath = false;
  for (const root of rootsToCheck) {
    try {
      const args = ["--validate-path", value, ctx.cwd];
      if (root) args.push(root);
      if (
        JSON.parse(
          execFileSync(rustAnalyzer(), args, {
            encoding: "utf8",
            timeout: 2000,
            maxBuffer: 1024 * 1024,
          }),
        ).valid === true
      ) {
        validPath = true;
        break;
      }
    } catch (_) {
      /* all failures intentionally collapse to invalid */
    }
  }
  if (!validPath) return undefined;
  // `/` has no path components. Treat it as a valid, explicit scope
  // instead of building a scope list containing `undefined`.
  const trimmed = value.replace(/\/+$/, "");
  if (!trimmed) {
    const picked = await ctx.ui.select(
      `Choose access scope for:\n\n  ${value}`,
      ["Requested path only — /"],
    );
    return picked === "Requested path only — /" ? "/" : undefined;
  }
  const parts = trimmed.split("/").filter(Boolean);
  const currentBoundary = Math.max(1, parts.length - 1);
  const boundaries = [
    currentBoundary,
    ...Array.from(
      { length: currentBoundary - 1 },
      (_, index) => currentBoundary - index - 1,
    ),
    ...Array.from(
      { length: parts.length - currentBoundary },
      (_, index) => currentBoundary + index + 1,
    ),
  ];
  // Build prefixes once (O(n)) rather than re-joining a slice per
  // boundary (O(n^2)) — matters once a malformed path has many
  // components.
  const prefixes: string[] = [];
  let acc = "";
  for (const part of parts) {
    acc += "/" + part;
    prefixes.push(acc);
  }
  const scopes = boundaries.map((boundary) => prefixes[boundary - 1]);
  const labels = scopes.map((scopePath, index) => {
    if (scopePath === value) return `Requested path only — ${scopePath}`;
    if (index === 0) return `Current scope (default) — ${scopePath}`;
    return `Broader scope — ${scopePath}`;
  });
  const picked = await ctx.ui.select(
    `Choose access scope for:\n\n  ${value}`,
    labels,
  );
  if (picked === undefined) return undefined;
  const index = labels.indexOf(picked);
  return index >= 0 ? scopes[index] : undefined;
};

const checkPath = async (
  ctx: any,
  value: string,
  pi: ExtensionAPI,
  tool = "path",
) => {
  if (!value) return undefined;
  const pathResult = checkPathAgainstRules(
    value,
    ctx.cwd,
    pathRules,
    sessionPathGrants,
    home,
  );
  if (pathResult.status === "deny")
    return { block: true, reason: pathResult.reason };
  if (pathResult.status === "allow") return undefined;
  const displayPath = pathResult.displayPath;
  if (value.length > MAX_PATH_LENGTH || value.includes("\0")) {
    return {
      block: true,
      reason: "Blocked: path exceeds safe length or contains a NUL byte",
    };
  }
  if (displayPath.split("/").filter(Boolean).length > MAX_PATH_SEGMENTS) {
    return {
      block: true,
      reason: "Blocked: path has too many segments to present for approval",
    };
  }
  if (!ctx.hasUI) {
    markPrompt(ctx, `path approval (${displayPath})`, "denied", "no-ui");
    return {
      block: true,
      reason: `Needs approval to access ${parentFolder(displayPath)} (no UI available)`,
    };
  }
  const folder = await choosePath(ctx, displayPath);
  if (!folder) {
    markPrompt(ctx, `path approval (${displayPath})`, "denied", "no-scope");
    return {
      block: true,
      reason: "Requested value cannot be granted as a filesystem path",
    };
  }
  const choice = await ctx.ui.select(
    `Allow access to folder?\n\n  ${folder}`,
    ["Once", "For this session", "No"],
  );
  markPrompt(
    ctx,
    `path approval (${folder})`,
    choice === "Once" || choice === "For this session" ? "allowed" : "denied",
    undefined,
    {
      scope: folder,
      duration: choice === "For this session" ? "session" : "once",
    },
  );
  // ctx.ui.select() returns undefined on cancel/timeout; only an
  // explicit "Once"/"For this session" choice grants access.
  if (choice !== "Once" && choice !== "For this session") {
    return { block: true, reason: "Blocked by user" };
  }
  if (choice === "For this session") rememberSessionPath(folder, pi);
  return undefined;
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    initializeForCwd(ctx.cwd);
    // Restore grants so they survive a reload or a later process
    // handling the same session, not just the current turn.
    restoreSessionGrants(ctx);
    // The directory Pi was started in is trusted for the session.
    const startupPath = normalize(ctx.cwd);
    sessionPathGrants.add(canonicalPath(startupPath) ?? startupPath);
  });
  const pathTools = ["read", "edit", "write", "ls", "grep", "find"];
  pi.on("tool_call", async (event, ctx) => {
    const shouldAudit = pathTools.includes(event.toolName) || event.toolName === "bash";
    const state: AuditState = { prompted: false, promptCount: 0 };
    if (shouldAudit) auditStates.set(ctx, state);
    let result: any;
    try {
      result = await (async () => {
        // Initialize lazily as well as from session_start. This covers the
        // first tool call when the extension was loaded after that lifecycle
        // event was emitted.
        initializeForCwd(ctx.cwd);
        // A primary agent's proposal tool appends the entry during the
        // same turn. Refresh here so approval takes effect immediately.
        restoreSessionGrants(ctx);
        if (pathTools.includes(event.toolName)) {
      const value = String(
        event.input.path ?? event.input.root ?? event.input.directory ?? "",
      );
      return checkPath(ctx, value, pi, event.toolName);
    }
    if (event.toolName !== "bash") return undefined;
    const classification = classifyCommand({
      command: String(event.input.command ?? ""),
      cwd: ctx.cwd,
      bashRules,
      sessionBashGrants,
    });
    const command = classification.command;
    event.input.command = command;
    if (classification.kind === "deny")
      return { block: true, reason: classification.reason };
    if (classification.kind === "opaque") {
      // Opaque syntax cannot be checked against path rules, but it is
      // still useful for an interactive user to approve a single
      // invocation. Do not persist this decision: the next opaque
      // command must be reviewed independently.
      return askBash(
        ctx,
        `opaque shell syntax (${classification.reason})`,
        command,
        event.toolName,
        classification.statements,
        commandAnnotations(classification),
      );
    }
    if (classification.kind === "interpreter")
      return askBash(
        ctx,
        `opaque interpreter (${classification.interpreter})`,
        command,
        event.toolName,
        classification.statements,
        commandAnnotations(classification),
      );
    // The remaining classifications all have a safe static analysis.
    if (!classification.analysis) return undefined;
    const analysis = classification.analysis;

    // Inspect explicit filesystem arguments and redirect targets even
    // when a command-level rule says allow. This prevents `ls ~/.ssh`,
    // `rg /secret`, or `jj log > ~/.ssh/x` from bypassing the same
    // path policy used by direct path tools.
    for (const path of [...analysis.paths, ...analysis.redirects]) {
      const result = await checkPath(ctx, path, pi, event.toolName);
      if (result) return result;
    }

    // Proposals are exact command grants. They reduce repeated
    // prompts without turning shell syntax into a new policy glob.
    // Check shell syntax and explicit paths first so a granted
    // command prefix cannot smuggle in a pipe or other control syntax.
    if (classification.kind === "grant") return undefined;
    if (classification.kind === "ask")
      return askBash(
        ctx,
        classification.rule?.glob ?? "permission rule",
        command,
        event.toolName,
        classification.statements,
        commandAnnotations(classification),
      );
    if (classification.kind === "unrecognized") {
      // Path arguments are checked above, but passing the path gate must not
      // make an otherwise unknown command executable. Unknown commands may
      // have side effects that the static path analysis cannot observe (for
      // example, `direnv allow .` writes direnv's trust marker elsewhere).
      return askBash(
        ctx,
        "unrecognized shell command",
        command,
        event.toolName,
        analysis.commands,
        commandAnnotations(classification),
      );
    }
        return undefined;
      })();
    } finally {
      if (shouldAudit) {
        const request = event.toolName === "bash"
          ? String(event.input.command ?? "").trim()
          : String(event.input.path ?? event.input.root ?? event.input.directory ?? "");
        recordPermissionRequest(ctx, {
          audit_version: 1,
          event: "permission_evaluation",
          tool: event.toolName,
          kind: event.toolName === "bash" ? "bash" : "path",
          request,
          potentially_promptable: true,
          prompted: state.prompted,
          prompt_count: state.promptCount,
          disposition: result?.block ? "deny" : "allow",
          decision: state.decision,
          rule: state.rule,
          reason: state.reason,
          statements: state.statements,
          scope: state.scope,
          duration: state.duration,
        });
        auditStates.delete(ctx);
      }
    }
    return result;
  });
}
