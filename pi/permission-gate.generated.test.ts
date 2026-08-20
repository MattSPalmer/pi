/**
 * Behavioral tests that load and execute the *actual generated* permission-gate
 * extension (as produced by default.nix), rather than a
 * reimplemented mock. `permission-gate.test.ts` covers the intended state
 * machine at a conceptual level; this file exists to catch regressions in the
 * generated TypeScript itself (escaping bugs, inverted conditionals, edge
 * cases in path normalization) that a parallel mock cannot detect.
 *
 * Requires GATE_SOURCE_PATH to point at the generated extension source (set
 * by the `permission-gate` flake check). If unset, these tests are skipped
 * rather than failed, so this file can still be run standalone.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const GATE_SOURCE_PATH = process.env.GATE_SOURCE_PATH;

type ToolResult = undefined | { block: true; reason: string };
type Handlers = {
  session_start?: (event: unknown, ctx: any) => Promise<unknown>;
  tool_call?: (event: unknown, ctx: any) => Promise<ToolResult>;
};

let counter = 0;

/** Load a fresh instance of the generated extension module. Each call gets
 * its own file (and therefore its own module-level state, e.g.
 * sessionPathGrants) so tests don't leak state into each other. */
async function loadGate(): Promise<{ handlers: Handlers; entries: unknown[] }> {
  if (!GATE_SOURCE_PATH) throw new Error("GATE_SOURCE_PATH not set");
  const source = readFileSync(GATE_SOURCE_PATH, "utf8");
  const dir = mkdtempSync(join(tmpdir(), "permission-gate-"));
  const file = join(dir, `gate-${counter++}.mts`);
  writeFileSync(file, source);
  const mod = await import(pathToFileURL(file).href);
  const handlers: Handlers = {};
  const entries: unknown[] = [];
  const pi = {
    on: (
      name: string,
      handler: (event: unknown, ctx: any) => Promise<unknown>,
    ) => {
      (handlers as any)[name] = handler;
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  };
  await mod.default(pi);
  return { handlers, entries };
}

function makeFixture() {
  // Canonicalize immediately: on macOS `tmpdir()` reports /var, but the gate
  // resolves existing paths via realpath (so it stores /private/var). Returning
  // the resolved root keeps later assertions on granted scope paths aligned.
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "permission-gate-fixture-")),
  );
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(join(root, "secret"), "secret");
  writeFileSync(join(root, "x"), "x");
  writeFileSync(join(root, "a", "file.txt"), "a");
  writeFileSync(join(root, "a", "other.txt"), "other");
  writeFileSync(join(root, "a", "b", "file.txt"), "b");
  mkdirSync(join(root, "restored"));
  writeFileSync(join(root, "restored", "file.txt"), "restored");
  return root;
}

function makeCtx(
  cwd: string,
  opts: {
    hasUI?: boolean;
    select?: (prompt: string, options: string[]) => Promise<string | undefined>;
    entries?: unknown[];
  } = {},
) {
  return {
    cwd,
    hasUI: opts.hasUI ?? true,
    ui: {
      select:
        opts.select ??
        (async () => {
          throw new Error("unexpected ui.select() call");
        }),
    },
    sessionManager: { getEntries: () => opts.entries ?? [] },
  };
}

/** Queue of canned responses for ctx.ui.select(), keyed by call order. Also
 * records every prompt string it was called with, for assertions on rendered
 * text (e.g. the newline-escaping regression). */
function fakeUi(
  fns: Array<(prompt: string, options: string[]) => string | undefined>,
) {
  let i = 0;
  const prompts: string[] = [];
  const select = async (prompt: string, options: string[]) => {
    prompts.push(prompt);
    const fn = fns[i++];
    if (!fn)
      throw new Error(`unexpected extra ui.select() call (prompt: ${prompt})`);
    return fn(prompt, options);
  };
  return { select, prompts };
}

test(
  "generated gate: GATE_SOURCE_PATH available",
  { skip: !GATE_SOURCE_PATH },
  () => {
    assert.ok(GATE_SOURCE_PATH);
  },
);

if (GATE_SOURCE_PATH) {
  test("generated gate: every evaluated path call is recorded for audit metrics", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "permission-gate-log-"));
    const log = join(logDir, "permission-requests.jsonl");
    const previousLog = process.env.PI_PERMISSION_LOG;
    process.env.PI_PERMISSION_LOG = log;
    try {
      const { handlers } = await loadGate();
      await handlers.session_start!({}, makeCtx("/work/project"));
      const result = await handlers.tool_call!(
        { toolName: "read", input: { path: "/work/project/a.ts" } },
        makeCtx("/work/project"),
      );
      assert.equal(result, undefined);
      const records = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const record = records.at(-1);
      assert.equal(record.audit_version, 1);
      assert.equal(record.event, "permission_evaluation");
      assert.equal(record.potentially_promptable, true);
      assert.equal(record.prompted, false);
      assert.equal(record.prompt_count, 0);
      assert.equal(record.disposition, "allow");
    } finally {
      if (previousLog === undefined) delete process.env.PI_PERMISSION_LOG;
      else process.env.PI_PERMISSION_LOG = previousLog;
    }
  });

  test("generated gate: root cwd trusts descendants (regression: isWithin('/', '/') bug)", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/"));
    const select = async () => {
      throw new Error("should not prompt: '/' must grant every absolute path");
    };
    const result = await handlers.tool_call!(
      { toolName: "read", input: { path: "/etc/passwd" } },
      makeCtx("/", { select }),
    );
    assert.equal(result, undefined);
  });

  test("generated gate: cancelling the folder-approval prompt blocks access (regression: undefined treated as allow)", async () => {
    const { handlers } = await loadGate();
    const root = makeFixture();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const { select } = fakeUi([
      (_prompt, options) => options[0], // choosePath: accept the default scope
      () => undefined, // approval prompt: user cancels/times out
    ]);
    const result = await handlers.tool_call!(
      { toolName: "read", input: { path: join(root, "secret") } },
      makeCtx("/work/project", { select }),
    );
    assert.deepEqual(result, { block: true, reason: "Blocked by user" });
  });

  test("generated gate: folder-approval prompt renders real newlines (regression: literal \\\\n text)", async () => {
    const { handlers } = await loadGate();
    const root = makeFixture();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const { select, prompts } = fakeUi([
      (_prompt, options) => options[0],
      () => "Once",
    ]);
    const result = await handlers.tool_call!(
      { toolName: "read", input: { path: join(root, "x") } },
      makeCtx("/work/project", { select }),
    );
    assert.equal(result, undefined);
    const approvalPrompt = prompts[1];
    assert.ok(
      approvalPrompt.includes("\n\n"),
      "approval prompt should contain a real blank line before the path",
    );
    assert.ok(
      !approvalPrompt.includes("\\n"),
      "approval prompt should not contain a literal backslash-n",
    );
  });

  test("generated gate: selecting a scope grants it for the session and covers siblings on the next call", async () => {
    const { handlers, entries } = await loadGate();
    const root = makeFixture();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const { select } = fakeUi([
      (_prompt, options) => options.find((o) => o.startsWith("Current scope"))!,
      () => "For this session",
    ]);
    const first = await handlers.tool_call!(
      { toolName: "read", input: { path: join(root, "a", "file.txt") } },
      makeCtx("/work/project", { select }),
    );
    assert.equal(first, undefined);
    assert.equal(entries.length, 1);
    assert.equal((entries[0] as any).customType, "permission-gate-path-grant");
    assert.equal((entries[0] as any).data.path, join(root, "a"));

    const second = await handlers.tool_call!(
      { toolName: "read", input: { path: join(root, "a", "other.txt") } },
      makeCtx("/work/project", {
        select: async () => {
          throw new Error("should not prompt again for a granted scope");
        },
      }),
    );
    assert.equal(second, undefined);
  });

  test("generated gate: scope options are labeled current/broader/requested (UX regression)", async () => {
    const { handlers } = await loadGate();
    const root = makeFixture();
    await handlers.session_start!({}, makeCtx("/work/project"));
    let seenOptions: string[] = [];
    const { select } = fakeUi([
      (_prompt, options) => {
        seenOptions = options;
        return options[0];
      },
      () => "No",
    ]);
    await handlers.tool_call!(
      { toolName: "read", input: { path: join(root, "a", "b", "file.txt") } },
      makeCtx("/work/project", { select }),
    );
    assert.ok(seenOptions[0].startsWith("Current scope (default) — "));
    assert.ok(
      seenOptions
        .slice(1, -1)
        .every((label) => label.startsWith("Broader scope — ")),
    );
    assert.ok(seenOptions.at(-1)!.startsWith("Requested path only — "));
  });

  test("generated gate: diff range expressions are not offered as path scopes", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const prompts: string[] = [];
    const result = await handlers.tool_call!(
      {
        toolName: "bash",
        input: {
          command:
            "sed -n '/^diff --git a\\/.circleci\\/config.yml/,/^diff --git a\\/(D|G|c)/p'",
        },
      },
      makeCtx("/work/project", {
        select: async (prompt) => {
          prompts.push(prompt);
          return "Yes";
        },
      }),
    );
    assert.ok(
      result && (result as any).block,
      "range expression must not become a path grant",
    );
    assert.ok(
      prompts.every((prompt) => !prompt.includes("Choose access scope")),
      "non-path range must not open a path-scope prompt",
    );
  });

  test("generated gate: oversized path is blocked before prompting (segment cap)", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const longPath =
      "/" + Array.from({ length: 70 }, (_, i) => `seg${i}`).join("/");
    const select = async () => {
      throw new Error("should not prompt for an oversized path");
    };
    const result = await handlers.tool_call!(
      { toolName: "read", input: { path: longPath } },
      makeCtx("/work/project", { select }),
    );
    assert.ok(
      result && (result as any).block,
      "oversized path should be blocked",
    );
  });

  test("generated gate: persisted session-path-grant entries are restored on session_start", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!(
      {},
      makeCtx("/work/project", {
        entries: [
          {
            type: "custom",
            customType: "permission-gate-path-grant",
            data: { path: "/tmp/restored" },
          },
        ],
      }),
    );
    const select = async () => {
      throw new Error(
        "should not prompt: grant was restored from session entries",
      );
    };
    const result = await handlers.tool_call!(
      { toolName: "read", input: { path: "/tmp/restored/file.txt" } },
      makeCtx("/work/project", { select }),
    );
    assert.equal(result, undefined);
  });

  test("generated gate: deny rule wins for an absolute path even if a relative candidate would resolve elsewhere", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    // The deny glob ("/Users/*/.ssh/**") is a fixed pattern, not `~`-relative,
    // so this must not depend on the build sandbox's actual $HOME.
    const result = await handlers.tool_call!(
      { toolName: "read", input: { path: "/Users/someone/.ssh/id_ed25519" } },
      makeCtx("/work/project"),
    );
    assert.ok(
      result && (result as any).block,
      "absolute .ssh path must be denied",
    );
    assert.match((result as any).reason, /Blocked by permission rule/);
  });

  test("generated gate: symlink escapes do not inherit the lexical project grant", async () => {
    const root = mkdtempSync(join(tmpdir(), "permission-gate-symlink-"));
    const project = join(root, "project");
    const outside = join(root, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    symlinkSync(outside, join(project, "link"), "dir");

    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx(project, { hasUI: false }));
    const result = await handlers.tool_call!(
      {
        toolName: "read",
        input: { path: join(project, "link", "secret.txt") },
      },
      makeCtx(project, { hasUI: false }),
    );
    assert.ok(
      result && (result as any).block,
      "a symlinked path outside the project must not inherit startup trust",
    );
    assert.match((result as any).reason, /Needs approval/);
  });

  test("generated gate: bash filesystem arguments use the path gate", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const result = await handlers.tool_call!(
      {
        toolName: "bash",
        input: { command: "ls /Users/someone/.ssh/id_ed25519" },
      },
      makeCtx("/work/project"),
    );
    assert.ok(
      result && (result as any).block,
      "bash path must inherit the .ssh deny rule",
    );
    assert.match((result as any).reason, /Blocked by permission rule/);
  });

  test("generated gate: shell control syntax is blocked even when a prefix rule would allow it", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const result = await handlers.tool_call!(
      {
        toolName: "bash",
        input: { command: "jj status; cat /Users/someone/.ssh/id_ed25519" },
      },
      makeCtx("/work/project"),
    );
    assert.ok(
      result && (result as any).block,
      "compound shell command must not inherit jj status allow",
    );
    assert.match(
      (result as any).reason,
      /shell command cannot be statically analyzed/,
    );
  });

  test("generated gate: opaque interpreters are blocked without execution", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const result = await handlers.tool_call!(
      { toolName: "bash", input: { command: "python3 -c 'print(1)'" } },
      makeCtx("/work/project", { hasUI: false }),
    );
    assert.ok(
      result && (result as any).block,
      "interpreter command must require approval",
    );
    assert.match((result as any).reason, /opaque/);
  });

  test("generated gate: pipelines of allowed commands are decomposed, not opaque", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const ui = fakeUi([]);
    const result = await handlers.tool_call!(
      { toolName: "bash", input: { command: "jj log -r @ | head -5" } },
      makeCtx("/work/project", { select: ui.select }),
    );
    // Both `jj log` and `head` are permitted commands; the pipeline must
    // still be decomposed rather than treated as opaque shell syntax.
    assert.equal(result, undefined);
    assert.equal(ui.prompts.length, 0);
  });

  test("generated gate: compound allowed jj commands run without prompting", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const result = await handlers.tool_call!(
      { toolName: "bash", input: { command: "jj status && jj diff" } },
      makeCtx("/work/project", { hasUI: false }),
    );
    assert.equal(result, undefined);
  });

  test("generated gate: unknown path-bearing commands still require approval", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const result = await handlers.tool_call!(
      {
        toolName: "bash",
        input: { command: "direnv allow . && ./bin/domain-context nix-system" },
      },
      makeCtx("/work/project", { hasUI: false }),
    );
    assert.ok(result && (result as any).block);
    assert.match((result as any).reason, /Needs approval/);
  });

  test("generated gate: single-quoted shell text does not prevent command splitting", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const command = `jj diff -- scripts/jj-run; jj diff --git scripts/jj-run; jj status --quiet; printf '\\n.gitignore files: $0\\n'; rg -n 'gitignore|exclude$' .`;
    const result = await handlers.tool_call!(
      { toolName: "bash", input: { command } },
      makeCtx("/work/project", { hasUI: false }),
    );
    assert.equal(result, undefined);
  });

  test("generated gate: redirect targets inherit path policy", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const result = await handlers.tool_call!(
      {
        toolName: "bash",
        input: { command: "jj log > /Users/someone/.aws/creds" },
      },
      makeCtx("/work/project", { hasUI: false }),
    );
    assert.ok(
      result && (result as any).block,
      "redirect into a denied path must be blocked",
    );
    assert.match((result as any).reason, /Blocked by permission rule/);
  });

  test("generated gate: interpreter names as arguments do not trigger the interpreter prompt", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const ui = fakeUi([() => "Yes"]);
    const result = await handlers.tool_call!(
      { toolName: "bash", input: { command: "jj file search python3" } },
      makeCtx("/work/project", { select: ui.select }),
    );
    assert.equal(result, undefined);
    // If any prompt fired, it must not be the interpreter prompt.
    for (const prompt of ui.prompts)
      assert.doesNotMatch(prompt, /opaque interpreter/);
  });

  test("generated gate: project permissions layer by directory and override higher-level rules", async () => {
    const root = mkdtempSync(join(tmpdir(), "permission-gate-project-"));
    const project = join(root, "project");
    mkdirSync(join(root, ".pi"));
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "permissions.json"),
      JSON.stringify({ bash: { "gh pr *": "allow" } }),
    );
    writeFileSync(
      join(project, ".pi", "permissions.json"),
      JSON.stringify({
        bash: { "gh pr list*": "deny", "gh pr checks*": "allow" },
      }),
    );

    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx(project, { hasUI: false }));
    const denied = await handlers.tool_call!(
      { toolName: "bash", input: { command: "gh pr list" } },
      makeCtx(project, { hasUI: false }),
    );
    assert.ok(
      denied && (denied as any).block,
      "nearest project rule should override a parent allow",
    );
    const allowed = await handlers.tool_call!(
      { toolName: "bash", input: { command: "gh pr checks" } },
      makeCtx(project, { hasUI: false }),
    );
    assert.equal(allowed, undefined);
  });

  test("generated gate: namespaced command policies are executable-agnostic", async () => {
    const root = mkdtempSync(join(tmpdir(), "permission-gate-command-policy-"));
    mkdirSync(join(root, ".pi"));
    writeFileSync(
      join(root, ".pi", "permissions.json"),
      JSON.stringify({
        commands: { hg: { READ: ["status"], WRITE: ["commit"] } },
      }),
    );

    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx(root));
    const allowed = await handlers.tool_call!(
      { toolName: "bash", input: { command: "hg status" } },
      makeCtx(root, { hasUI: false }),
    );
    assert.equal(allowed, undefined);
    const approval = await handlers.tool_call!(
      { toolName: "bash", input: { command: "hg commit" } },
      makeCtx(root, { hasUI: false }),
    );
    assert.ok(approval && (approval as any).block);
    assert.match((approval as any).reason, /hg commit\*/);
  });

  test("generated gate: a simple allowed command still works", async () => {
    const { handlers } = await loadGate();
    await handlers.session_start!({}, makeCtx("/work/project"));
    const result = await handlers.tool_call!(
      { toolName: "bash", input: { command: "pwd" } },
      makeCtx("/work/project", { hasUI: false }),
    );
    assert.equal(result, undefined);
  });

  test("generated gate: policy is initialized if the first tool call precedes session_start", async () => {
    const { handlers } = await loadGate();
    const result = await handlers.tool_call!(
      { toolName: "bash", input: { command: "pwd" } },
      makeCtx("/work/project", { hasUI: false }),
    );
    assert.equal(result, undefined);
  });
}
