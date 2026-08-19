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
    "gh api * --method *": { action: "deny", context: "mutating gh api is not permitted" },
    "gh api * --method=*": { action: "deny", context: "mutating gh api is not permitted" },
    "gh api * -X *": { action: "deny", context: "mutating gh api is not permitted" },
    "gh api * -X*": { action: "deny", context: "mutating gh api is not permitted" },
    "gh api * --field *": { action: "deny", context: "mutating gh api is not permitted" },
    "gh api * --field=*": { action: "deny", context: "mutating gh api is not permitted" },
    "gh api * --input *": { action: "deny", context: "mutating gh api is not permitted" },
    "gh api * --input=*": { action: "deny", context: "mutating gh api is not permitted" },
    "gh api * -F*": { action: "deny", context: "mutating gh api is not permitted" },
    "gh api * -f*": { action: "deny", context: "mutating gh api is not permitted" },
    "gh api * -i*": { action: "deny", context: "mutating gh api is not permitted" },
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

test("classifies opaque interpreter variants", () => {
  for (const command of [
    "sh -c 'echo unsafe'",
    "bash -c 'echo unsafe'",
    "zsh -c 'echo unsafe'",
    "python -c 'print(1)'",
    "python3 -c 'print(1)'",
    "node -e 'console.log(1)'",
    "ruby -e 'puts 1'",
    "perl -e 'print 1'",
    "xargs cat",
  ]) {
    expect(classifyCommand({ command, cwd, bashRules: rules.bash }).kind).toBe("interpreter");
  }
});

test("redirects and traversal paths cannot inherit the project grant", () => {
  for (const operator of [">", ">>", "2>", "&>"]) {
    expect(evaluateAllowlist({
      command: `jj log ${operator} ${join(home, ".ssh", "creds")}`,
      cwd,
      rules,
    }).verdict, operator).toBe("deny");
  }
  expect(evaluateAllowlist({
    command: `cat ${join(cwd, "..", "outside", "file.txt")}`,
    cwd,
    rules,
  }).verdict).toBe("needs-confirmation");
});

test("gh api mutation variants are denied while reads are not", () => {
  const denied = [
    "gh api repos/acme/project --method POST",
    "gh api repos/acme/project --method=POST",
    "gh api repos/acme/project -XPOST",
    "gh api repos/acme/project --field title=x",
    "gh api repos/acme/project --input body.json",
    "gh api repos/acme/project -Ftitle=x",
    "gh api repos/acme/project -ftitle=x",
    "gh api repos/acme/project -i",
  ];
  for (const command of denied) {
    expect(evaluateAllowlist({ command, cwd, rules }).verdict, command).toBe("deny");
  }
  expect(evaluateAllowlist({ command: "gh api repos/acme/project", cwd, rules }).verdict).not.toBe("deny");
});

test("sensitive path boundaries do not overmatch", () => {
  expect(checkPathAgainstRules(join(home, ".ssh", "id_rsa"), cwd, rules.paths).status).toBe("deny");
  expect(checkPathAgainstRules(join(home, ".sshx", "id_rsa"), cwd, rules.paths).status).toBe("unknown");
});

test("falls back to user defaults when an override config dir has no defaults", () => {
  const configDir = join(root, "empty-config");
  mkdirSync(configDir, { recursive: true });
  const previousConfig = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = configDir;
  try {
    const active = loadPolicyRules(cwd, home);
    expect(evaluateAllowlist({ command: "sort", cwd, rules: active }).verdict).toBe("allow");
  } finally {
    if (previousConfig === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = previousConfig;
  }
});

test("delegated-agent policy is applied as the highest-precedence layer", () => {
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
    const active = loadPolicyRules(cwd, home);
    expect(evaluateAllowlist({ command: "sort input", cwd, rules: active }).verdict).toBe("deny");
  } finally {
    if (previousConfig === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = previousConfig;
    if (previousScope === undefined) delete process.env.PI_SUBAGENT_NAME;
    else process.env.PI_SUBAGENT_NAME = previousScope;
  }
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

test("session command grants do not authorize appended shell commands", () => {
  const grants = { bash: ["formatter *"], paths: [] };
  expect(evaluateAllowlist({
    command: "formatter input; rm -rf ./target",
    cwd,
    rules,
    grants,
  }).verdict).toBe("needs-confirmation");
  expect(evaluateAllowlist({
    command: "formatter input && unknown-tool",
    cwd,
    rules,
    grants,
  }).verdict).toBe("needs-confirmation");
});
