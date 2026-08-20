import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function run(script: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (x) => {
      out += x;
    });
    child.stderr.on("data", (x) => {
      err += x;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(err || `report exited ${code}`)),
    );
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("session-report", {
    description: "Generate a Polars report from deduplicated Pi JSONL sessions",
    handler: async (args, ctx) => {
      const dir = await mkdtemp(join(tmpdir(), "pi-session-report-"));
      const script = join(dir, "report.py");
      try {
        // The extension is packaged as a directory, so this remains available
        // when the immutable Pi configuration is in the Nix store.
        const source = join(import.meta.dir, "report.py");
        await writeFile(script, await readFile(source));
        await chmod(script, 0o700);
        const prefixes = (args ?? "").trim().split(/\s+/).filter(Boolean);
        const report = await run(script, prefixes, ctx.cwd);
        const output = join(ctx.cwd, ".pi", "session-report.md");
        await writeFile(output, report);
        ctx.ui.notify(`Session report written to ${output}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Session report failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  });
}
