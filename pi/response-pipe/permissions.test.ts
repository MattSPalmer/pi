import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePipePermissions } from "./permissions.ts";

const root = mkdtempSync(join(tmpdir(), "response-pipe-permissions-"));
const home = join(root, "home");
const cwd = join(root, "project");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(home, ".pi", "agent", "permissions.defaults.json"), JSON.stringify({
  bash: {
    "sort": "allow",
    "sort *": "allow",
    "cat *": "allow",
    "git *": { action: "deny", context: "git is not permitted" },
  },
  paths: { allow: [`${cwd}/**`] },
}));

const evaluate = (command: string, sessionEntries: unknown[] = []) =>
  evaluatePipePermissions({ command, cwd, home, sessionEntries });

test("allowlisted commands skip confirmation while unknown commands do not", () => {
  expect(evaluate("sort")).toMatchObject({ verdict: "allow", basis: "sort" });
  expect(evaluate("unknown-tool")).toMatchObject({ verdict: "needs-confirmation" });
});

test("permission denials are hard blocks", () => {
  expect(evaluate("git status")).toMatchObject({
    verdict: "deny",
    reason: expect.stringContaining("git is not permitted"),
  });
});

test("allowlisted commands still require covered path arguments", () => {
  expect(evaluate(`cat ${join(cwd, "input.txt")}`).verdict).toBe("allow");
  expect(evaluate(`cat ${join(root, "outside.txt")}`).verdict).toBe("needs-confirmation");
});

test("response-pipe applies delegated-agent policy restrictions", () => {
  const configDir = join(root, "agent-config");
  mkdirSync(join(configDir, "permissions"), { recursive: true });
  writeFileSync(join(configDir, "permissions.defaults.json"), JSON.stringify({
    bash: { "sort *": "allow" },
    paths: { allow: [`${cwd}/**`] },
  }));
  writeFileSync(join(configDir, "permissions", "restricted.json"), JSON.stringify({
    bash: { "sort *": { action: "deny", context: "agent is read-only" } },
  }));
  const previousConfig = process.env.PI_CONFIG_DIR;
  const previousScope = process.env.PI_SUBAGENT_NAME;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.PI_SUBAGENT_NAME = "restricted";
  try {
    expect(evaluate("sort input").verdict).toBe("deny");
  } finally {
    if (previousConfig === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = previousConfig;
    if (previousScope === undefined) delete process.env.PI_SUBAGENT_NAME;
    else process.env.PI_SUBAGENT_NAME = previousScope;
  }
});

test("session grants are portable across the integration boundary", () => {
  const entries = [{
    type: "custom",
    customType: "permission-gate-path-grant",
    data: { command: "formatter *" },
  }];
  expect(evaluate("formatter input", entries).verdict).toBe("allow");
});

test("session grants do not authorize appended shell commands", () => {
  const entries = [{
    type: "custom",
    customType: "permission-gate-path-grant",
    data: { command: "formatter *" },
  }];
  expect(evaluate("formatter input; rm -rf ./target", entries).verdict).toBe("needs-confirmation");
});
