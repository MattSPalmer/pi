import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

type JjResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type WorkingCopy = {
  operationId: string;
  changeId: string;
  diff: string;
};

type Task = {
  baseline: Map<string, WorkingCopy>;
  workspaces: string[];
  guarded: Set<string>;
  explicitNew: boolean;
  failed: boolean;
};

const MODE_ENTRY = "committing-mode-state";
const enabledByEnvironment = () => {
  const value = process.env.PI_COMMITTING_MODE?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
};
const isSubagent = Boolean(process.env.PI_SUBAGENT_NAME);
// Pocket creates an in-memory agent session inside the primary process. It
// inherits the installed extensions, but its turns are not primary-session
// tasks and must not create jj change boundaries.
const isPocketSession = () => process.env.PI_POCKET_SESSION === "1";
// The nested `pi --no-tools --print` describer process inherits the installed
// extensions. Verified empirically that it only snapshots the working copy, but
// flag it anyway so it can never establish a change boundary for its own run.
const isDescriberSession = () => process.env.PI_COMMITTING_DESCRIBE_SESSION === "1";

// Polyrepo consumers can set this to the workspace that owns the current task.
// Keeping the selector as an environment contract avoids embedding domain-specific
// consumer discovery in this generic extension. Relative paths are resolved from
// Pi's cwd; absolute paths are used as-is.
export const targetWorkspace = (cwd: string) => {
  const configured = process.env.PI_COMMITTING_WORKSPACE?.trim();
  return configured ? (isAbsolute(configured) ? configured : resolve(cwd, configured)) : cwd;
};

// Snapshot once before a read phase. Read-only jj commands otherwise scan the
// working copy and integrate operations, which is costly across many repos and
// makes concurrent inspection contend on the operation log.
const jjReadOptions = ["--ignore-working-copy", "--no-integrate-operation"];

const run = (args: string[], cwd: string, input?: string): Promise<JjResult> =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: JjResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      // Do not use a shell here. The extension is deliberately only asking jj
      // to inspect the repository or create a child change.
      const isDescribe = args[0] === "__pi_describe__";
      child = spawn(isDescribe ? "pi" : "jj", isDescribe ? args.slice(1) : args, {
        cwd,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env: isDescribe ? { ...process.env, PI_COMMITTING_DESCRIBE_SESSION: "1" } : process.env,
      });
    } catch (error) {
      finish({ code: 127, stdout, stderr: String(error) });
      return;
    }

    if (input !== undefined) child.stdin?.end(input);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ code: 127, stdout, stderr: stderr || String(error) });
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout, stderr });
    });
  });

const workingCopy = async (cwd: string): Promise<WorkingCopy | null> => {
  // This is the one deliberate working-copy snapshot for the read phase.
  const snapshot = await run(["status", "--quiet"], cwd);
  if (snapshot.code !== 0) return null;
  // jj templates treat single-quoted strings as raw: '\n' appends a literal
  // backslash-n rather than a newline. Use double quotes so the separator is a
  // real newline and the parsed ids stay usable inside revsets.
  const [operation, changeId, diff] = await Promise.all([
    run(["op", "log", ...jjReadOptions, "-n", "1", "-T", 'id ++ "\\n"', "--no-graph", "--no-pager"], cwd),
    run(["log", ...jjReadOptions, "-r", "@", "-T", 'change_id ++ "\\n"', "--no-graph", "--no-pager"], cwd),
    run(["diff", ...jjReadOptions, "--git", "--no-pager"], cwd),
  ]);
  if (operation.code !== 0 || changeId.code !== 0 || diff.code !== 0) return null;
  return { operationId: operation.stdout.trim(), changeId: changeId.stdout.trim(), diff: diff.stdout };
};

export const parseConsumers = (stdout: string, cwd: string): string[] =>
  stdout.split("\n").map((p) => p.trim()).filter(Boolean).map((p) => isAbsolute(p) ? p : resolve(cwd, p));

type ConsumerLister = (cwd: string) => Promise<JjResult>;
type WorkspaceRootCheck = (path: string) => Promise<boolean>;

const isWorkspaceRoot: WorkspaceRootCheck = async (path) => {
  const repository = await run(["root", ...jjReadOptions], path);
  const root = repository.stdout.trim();
  return repository.code === 0 && root !== "" && resolve(root) === resolve(path);
};

export const discoverConsumers = async (
  cwd: string,
  listConsumers: ConsumerLister = (root) => runExternal("polyrepo-consumer", ["list"], root),
  workspaceRoot: WorkspaceRootCheck = isWorkspaceRoot,
): Promise<string[]> => {
  // The generated helper may be globally installed for a different domain, so
  // successful execution alone does not establish that cwd is a polyrepo root.
  // Require every listed path to be a direct child and an actual jj workspace
  // root. This also lets an umbrella root be a jj repository without hiding its
  // consumer workspaces.
  const listed = await listConsumers(cwd);
  if (listed.code === 0) {
    const paths = parseConsumers(listed.stdout, cwd);
    const domainRoot = resolve(cwd);
    const directChildren = paths.length > 0 && paths.every((path) => dirname(resolve(path)) === domainRoot);
    if (directChildren && (await Promise.all(paths.map(workspaceRoot))).every(Boolean)) return paths;
  }
  return [targetWorkspace(cwd)];
};

const runExternal = (program: string, args: string[], cwd: string): Promise<JjResult> =>
  new Promise((resolve) => {
    const child = spawn(program, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (x) => stdout += x); child.stderr.on("data", (x) => stderr += x);
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export const taskRangeRevset = (baselineChangeId: string) => `(${baselineChangeId}::@) & mutable()`;

const taskChanges = async (baselineChangeId: string, cwd: string): Promise<string[] | null> => {
  const result = await run(["log", ...jjReadOptions, "-r", taskRangeRevset(baselineChangeId), "-T", 'change_id ++ "\\n"', "--no-graph", "--no-pager"], cwd);
  if (result.code !== 0) return null;
  return result.stdout.split("\n").map((id) => id.trim()).filter(Boolean);
};

const hasChanged = (before: WorkingCopy | undefined, after: WorkingCopy | null) =>
  after !== null && after.diff.trim().length > 0 &&
  (before === undefined || before.operationId !== after.operationId || before.diff !== after.diff);

const containsJjNew = (command: unknown) => {
  if (typeof command !== "string") return false;
  // This intentionally errs on the side of not creating a second change. A
  // command which attempts `jj new` may be blocked or fail, but blindly
  // creating another change after it would be the more surprising outcome.
  return /\bjj\s+new(?:\s|$)/.test(command);
};

const failedAgentEnd = (event: any) => {
  if (event?.aborted === true || event?.success === false || event?.error != null) return true;
  const terminalState = [event?.reason, event?.status, event?.stopReason].filter(
    (value) => typeof value === "string",
  );
  if (terminalState.some((value) => ["error", "failed", "failure", "aborted", "cancelled"].includes(value))) {
    return true;
  }
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  return messages.some(
    (message: any) =>
      message?.role === "assistant" &&
      ["error", "aborted", "cancelled"].includes(message?.stopReason),
  );
};

export default function (pi: ExtensionAPI) {
  let enabled = enabledByEnvironment();
  let task: Task | undefined;

  // Event handlers may outlive the session that created their context (for
  // example, when the user starts or switches sessions while the nested
  // describer is running). Notifications are best-effort and must never turn
  // that normal race into an extension error.
  const notify = (ctx: any, message: string, level: "info" | "warning" | "error" = "info") => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(message, level);
    } catch (_) {
      // The context is stale after a session replacement or reload. There is
      // no current-session context available to this event, so skip quietly.
    }
  };

  pi.registerCommand("committing-mode", {
    description: "Enable or disable automatic jj changes after completed tasks",
    handler: async (args, ctx) => {
      const value = String(args ?? "").trim().toLowerCase();
      if (["on", "enable", "enabled"].includes(value)) enabled = true;
      else if (["off", "disable", "disabled"].includes(value)) enabled = false;
      else if (value !== "" && value !== "status") {
        notify(ctx, "Usage: /committing-mode [on|off|status]", "warning");
        return;
      }

      if (value !== "" && value !== "status") {
        pi.appendEntry(MODE_ENTRY, { enabled });
      }
      notify(ctx, `Committing mode is ${enabled ? "enabled" : "disabled"}.`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // The setting is session-persistent, while the environment remains a
    // convenient process-wide default (PI_COMMITTING_MODE=0 disables it).
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
      const value = (entry as any).data?.enabled;
      if (typeof value === "boolean") enabled = value;
    }
    task = undefined;
  });

  pi.on("agent_start", async (_event, ctx) => {
    // Delegated Pi processes inherit the global extensions. They must not
    // create changes for their individual review/research runs.
    if (!enabled || isSubagent || isPocketSession() || isDescriberSession() || task) return;
    const workspaceList = await discoverConsumers(ctx.cwd);
    const snapshots = new Map<string, WorkingCopy>();
    const guarded = new Set<string>();
    const primary = targetWorkspace(ctx.cwd);
    // Workspaces are independent repositories. Snapshot/inspect them in
    // parallel; workingCopy serializes each repository's snapshot with its
    // concurrent read phase.
    await Promise.all(workspaceList.map(async (workspace) => {
      let snapshot = await workingCopy(workspace);
      if (snapshot?.diff.trim() && resolve(workspace) !== resolve(primary)) {
        guarded.add(workspace);
        return;
      }
      if (snapshot?.diff.trim()) {
        // Establish a clean task boundary before the model starts. jj snapshots
        // the pre-existing edits into the parent and leaves the new working
        // copy available for this task.
        const separated = await run(["new"], workspace);
        if (separated.code === 0) snapshot = await workingCopy(workspace);
      }
      if (snapshot) snapshots.set(workspace, snapshot);
    }));
    if (guarded.size) notify(ctx, `Leaving pre-existing work untouched in: ${[...guarded].join(", ")}`, "warning");
    task = { baseline: snapshots, workspaces: workspaceList, guarded, explicitNew: false, failed: false };
  });

  pi.on("agent_end", async (event) => {
    // Refresh rather than latch this value: an earlier low-level run may
    // fail and be retried or compacted before the eventual settled run.
    if (task) task.failed = failedAgentEnd(event);
  });

  // Track both model-issued shell commands and commands typed with ! / !!.
  // Tracking at tool_call time also covers a blocked or interrupted command,
  // where creating a new change automatically would be unsafe.
  pi.on("tool_call", async (event) => {
    if (task && event.toolName === "bash" && containsJjNew(event.input?.command)) {
      task.explicitNew = true;
    }
  });
  pi.on("user_bash", async (event) => {
    if (task && containsJjNew(event.command)) task.explicitNew = true;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const current = task;
    task = undefined;
    if (!current || !enabled || current.failed || current.explicitNew) return;

    const changed: Array<[string, WorkingCopy]> = [];
    for (const workspace of current.workspaces) {
      if (current.guarded.has(workspace)) continue;
      const after = await workingCopy(workspace);
      const baseline = current.baseline.get(workspace);
      if (!baseline || !after) continue;
      const range = await taskChanges(baseline.changeId, workspace);
      if (range === null) {
        // A failed ancestry query is a bug in this extension, not a normal
        // "nothing to do" outcome. Staying silent here hid a revset quoting
        // regression in which no change was ever described.
        notify(ctx, `Committing mode could not resolve the task range in ${workspace}; skipping.`, "error");
        continue;
      }
      if (!range.includes(after.changeId)) continue;
      if (hasChanged(baseline, after)) changed.push([workspace, after]);
    }
    if (changed.length === 0) return;
    if (changed.length > 1 && !ctx.hasUI) return;

    for (const [workspace, after] of changed) {
      // Ask the focused, tool-less subagent for the description before creating
      // the child. This mirrors sweep-rewrite's diff-to-commit-message prompt.
      const diff = after.diff;
      let describerPrompt: string;
    try {
      const agentsDir = process.env.PI_CONFIG_DIR
        ? join(process.env.PI_CONFIG_DIR, "agents")
        : join(process.env.HOME ?? "", ".pi", "agent", "agents");
      describerPrompt = readFileSync(join(agentsDir, "jj-change-describer.md"), "utf8");
      } catch (error) {
        notify(ctx, `Committing mode could not load the jj change describer prompt: ${String(error)}`, "error");
        continue;
      }
      const model = process.env.PI_COMMITTING_MODEL?.trim();
      const descriptionArgs = [
        "__pi_describe__",
        ...(model ? ["--model", model] : []),
        "--append-system-prompt", describerPrompt, "--no-session", "--no-tools", "--print",
      ];
      const description = await run(descriptionArgs, workspace, diff);
      if (description.code !== 0 || description.stdout.trim() === "") {
      notify(
        ctx,
        `Committing mode failed: could not generate a jj change description${description.stderr.trim() ? ` (${description.stderr.trim()})` : ` (nested Pi exited with code ${description.code})`}`, 
        "error",
      );
        continue;
      }

      const described = await run(["describe", "--stdin"], workspace, description.stdout.trim());
      if (described.code !== 0) {
      notify(ctx, `Committing mode could not apply the jj description${described.stderr.trim() ? `: ${described.stderr.trim()}` : "."}`, "error");
        continue;
      }

      const result = await run(["new"], workspace);
      if (result.code === 0) {
      notify(ctx, "Committing mode: described the completed change and started a new jj change.");
    } else {
      notify(
        ctx,
        `Committing mode could not run jj new${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`,
        "error",
      );
      }
    }
  });
}
