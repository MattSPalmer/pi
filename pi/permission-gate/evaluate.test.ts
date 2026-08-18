import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "permission-evaluate-")));
const home = join(root, "home");
const cwd = join(root, "project");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(home, ".pi", "agent", "permissions.defaults.json"), JSON.stringify({
  bash: {
    "sort": "allow",
    "sort *": "allow",
    "cat *": "allow",
    "git *": { action: "deny", context: "use jj instead" },
    "rm *": "ask",
  },
  paths: {
    allow: [`${cwd}/**`],
    deny: [`${home}/.ssh/**`],
  },
}));

process.env.PI_PERMISSION_ANALYZER = "tree-sitter-bash-analyzer";
const {
  checkPathAgainstRules,
  classifyCommand,
  evaluateAllowlist,
  loadPolicyRules,
  sessionGrantsFromEntries,
} = await import("./evaluate.ts");

const rules = loadPolicyRules(cwd, home);

test("classifies allow, deny, ask, and unrecognized commands", () => {
  expect(classifyCommand({ command: "sort", cwd, bashRules: rules.bash }).kind).toBe("allow");
  const denied = classifyCommand({ command: "git status", cwd, bashRules: rules.bash });
  expect(denied.kind).toBe("deny");
  expect(denied.reason).toContain("use jj instead");
  expect(classifyCommand({ command: "rm file", cwd, bashRules: rules.bash }).kind).toBe("ask");
  expect(classifyCommand({ command: "unknown-tool", cwd, bashRules: rules.bash }).kind).toBe("unrecognized");
});

test("classifies opaque syntax and strips redundant working-directory prefixes", () => {
  expect(classifyCommand({ command: `cd '${cwd}' && sort`, cwd, bashRules: rules.bash })).toMatchObject({
    kind: "allow",
    command: "sort",
  });
  expect(classifyCommand({ command: "python3 -c 'print(1)'", cwd, bashRules: rules.bash }).kind).toBe("interpreter");
  expect(classifyCommand({ command: "echo $(pwd)", cwd, bashRules: rules.bash }).kind).toBe("opaque");
  expect(classifyCommand({ command: "cat ~/.ssh/id_rsa $(pwd)", cwd, bashRules: rules.bash }).kind).toBe("deny");
});

test("checks policy paths and persisted session grants without UI", () => {
  expect(checkPathAgainstRules(join(cwd, "input.txt"), cwd, rules.paths, [cwd]).status).toBe("allow");
  expect(checkPathAgainstRules(join(home, ".ssh", "id_rsa"), cwd, rules.paths).status).toBe("deny");
  const outside = join(root, "outside", "file.txt");
  expect(checkPathAgainstRules(outside, cwd, rules.paths).status).toBe("unknown");
  expect(checkPathAgainstRules(outside, cwd, rules.paths, [join(root, "outside")]).status).toBe("allow");
});

test("allowlist evaluation requires positive command and path coverage", () => {
  expect(evaluateAllowlist({ command: "sort", cwd, rules })).toMatchObject({ verdict: "allow" });
  expect(evaluateAllowlist({ command: "git status", cwd, rules })).toMatchObject({ verdict: "deny" });
  expect(evaluateAllowlist({ command: "rm file", cwd, rules })).toMatchObject({ verdict: "needs-confirmation" });
  expect(evaluateAllowlist({ command: `cat ${join(root, "outside", "file.txt")}`, cwd, rules })).toMatchObject({
    verdict: "needs-confirmation",
  });
});

test("session command grants allow bounded command prefixes", () => {
  const grants = sessionGrantsFromEntries([
    { type: "custom", customType: "permission-gate-path-grant", data: { command: "formatter *" } },
    { type: "custom", customType: "permission-gate-path-grant", data: { path: join(root, "outside") } },
    { type: "custom", customType: "permission-gate-path-grant", data: { command: "x".repeat(4097) } },
    { type: "custom", customType: "other", data: { command: "ignored *" } },
  ]);
  expect(grants).toEqual({
    bash: ["formatter *"],
    paths: [join(root, "outside")],
  });
  expect(evaluateAllowlist({
    command: "formatter input",
    cwd,
    rules,
    grants,
  }).verdict).toBe("allow");
});
