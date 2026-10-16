/** Exercise the patched upstream extension without starting Pi or an LLM.
 * SUBAGENT_SOURCE_PATH points to the packaged subagent extension directory. */
import { build } from "bun";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const extension = process.env.SUBAGENT_SOURCE_PATH;
const require = createRequire(import.meta.url);

if (extension) {
  // Bundle the real module graph, not a reimplementation of agent discovery
  // or dispatch. Only Pi's SDK and the child process are replaced below.
  const built = await build({
    entrypoints: [join(extension, "index.ts")],
    target: "node",
    format: "cjs",
    external: ["@earendil-works/*", "typebox"],
  });
  assert.ok(built.success, built.logs.map(String).join("\n"));
  const source = await built.outputs[0].text();

  function fixture(
    options: {
      context?: "present" | "missing" | "invalid";
      tools?: string | string[];
    } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
    const config = join(root, "config");
    mkdirSync(join(config, "agents"), { recursive: true });
    const contextFile = join(root, "context.json");
    const context = '[{"id":1}]\n';
    const frontmatter: Record<string, unknown> = {
      name: "worker",
      description: "Test worker",
      tools: options.tools,
    };
    if (options.context === "invalid") frontmatter.contextFile = 42;
    else if (options.context) frontmatter.contextFile = contextFile;
    if (options.context === "present") writeFileSync(contextFile, context);
    // A JSON mapping is also valid YAML frontmatter. Parsing belongs to Pi;
    // the stub preserves its contract so we can test metadata propagation.
    writeFileSync(
      join(config, "agents", "worker.md"),
      `---\n${JSON.stringify(frontmatter)}\n---\nWorker instructions.`,
    );

    const spawns: Array<{ command: string; args: string[] }> = [];
    const spawn = (command: string, args: string[]) => {
      spawns.push({ command, args: [...args] });
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => {
        proc.stdout.emit(
          "data",
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
          }) + "\n",
        );
        proc.emit("close", 0);
      });
      return proc;
    };
    const sdk = {
      CONFIG_DIR_NAME: ".pi",
      getAgentDir: () => join(root, "user"),
      parseFrontmatter: (text: string) => {
        const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
        assert.ok(match);
        return { frontmatter: JSON.parse(match[1]), body: match[2] };
      },
      withFileMutationQueue: (_path: string, run: () => Promise<unknown>) =>
        run(),
      StringEnum: () => ({}),
      Type: Object.fromEntries(
        ["Object", "String", "Optional", "Array", "Boolean"].map((name) => [
          name,
          () => ({}),
        ]),
      ),
    };
    const module = { exports: {} as { default: (pi: any) => void } };
    runInNewContext(
      source,
      {
        module,
        exports: module.exports,
        require: (name: string) => {
          if (name === "node:child_process") return { spawn };
          if (name.startsWith("@earendil-works/") || name === "typebox")
            return sdk;
          return require(name);
        },
        process: {
          env: { PI_CONFIG_DIR: config },
          argv: ["pi"],
          execPath: "/test/pi",
        },
        Buffer,
        setTimeout,
      },
      { filename: join(extension!, "index.ts") },
    );
    let tool: any;
    module.exports.default({
      registerTool: (registered: any) => {
        tool = registered;
      },
    });
    assert.equal(tool?.name, "subagent");
    return {
      spawns,
      contextFile,
      context,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
      run: (task: string) =>
        tool.execute(
          "call-1",
          { agent: "worker", task },
          undefined,
          undefined,
          {
            cwd: root,
            hasUI: false,
          },
        ),
    };
  }

  test("packaged subagent reads contextFile metadata and injects it into the child task", async (t) => {
    const f = fixture({ context: "present", tools: "none" });
    t.after(f.cleanup);
    const result = await f.run("review this");
    assert.notEqual(result.isError, true);
    assert.equal(f.spawns.length, 1);
    const args = f.spawns[0].args;
    assert.equal(
      args.at(-1),
      `Task: review this\n\nInjected context from ${f.contextFile}:\n${f.context}`,
    );
    assert.ok(args.includes("--no-tools"));
    assert.ok(!args.includes("--tools"));
  });

  test("packaged subagent fails before spawning when its context file is missing", async (t) => {
    const f = fixture({ context: "missing" });
    t.after(f.cleanup);
    const result = await f.run("review this");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Could not read context file/);
    assert.equal(f.spawns.length, 0);
  });

  test("packaged subagent leaves ordinary tasks and explicit tools unchanged", async (t) => {
    const f = fixture({ tools: ["read", "bash"] });
    t.after(f.cleanup);
    const result = await f.run("ordinary task");
    assert.notEqual(result.isError, true);
    assert.equal(f.spawns.length, 1);
    const args = f.spawns[0].args;
    assert.equal(args.at(-1), "Task: ordinary task");
    assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
    assert.ok(!args.includes("--no-tools"));
  });

  test("packaged subagent ignores non-string contextFile metadata", async (t) => {
    const f = fixture({ context: "invalid" });
    t.after(f.cleanup);
    const result = await f.run("ordinary task");
    assert.notEqual(result.isError, true);
    assert.equal(f.spawns.length, 1);
    assert.equal(f.spawns[0].args.at(-1), "Task: ordinary task");
  });
}
