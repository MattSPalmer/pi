/**
 * Behavioral tests for the generated permission-gate extension.
 *
 * These tests use the same mock shape as Pi's ExtensionAPI and deliberately
 * exercise the path-grant state machine: startup trust, one-shot grants, and
 * session grants. Keep this small harness dependency-free so it can run with
 * `bun`.
 */
import assert from "node:assert/strict";
import { isAbsolute, normalize, resolve } from "node:path";
import test from "node:test";

type Choice = "Once" | "For this session" | "No";
type Event = { toolName: string; input: Record<string, unknown> };

const parentFolder = (path: string) => path.slice(0, path.lastIndexOf("/")) || path;

test("startup directory trusts absolute and relative descendants", async () => {
  const gate = mockGate("/work/project");
  assert.equal(await gate.call({ toolName: "read", input: { path: "/work/project/a.ts" } }), undefined);
  assert.equal(await gate.call({ toolName: "read", input: { path: "src/a.ts" } }), undefined);
  assert.equal(gate.prompts, 0);
});

test("once grants only the current call", async () => {
  const gate = mockGate("/work/project", ["Once"]);
  assert.equal(await gate.call({ toolName: "read", input: { path: "/tmp/a" } }), undefined);
  assert.equal(await gate.call({ toolName: "read", input: { path: "/tmp/b" } }), "denied");
  assert.equal(gate.prompts, 2);
});

test("session grants cover absolute and relative descendants", async () => {
  const gate = mockGate("/work/project", ["For this session"]);
  assert.equal(await gate.call({ toolName: "read", input: { path: "/tmp/a" } }), undefined);
  assert.equal(await gate.call({ toolName: "write", input: { path: "/tmp/nested/b" } }), undefined);
  assert.equal(await gate.call({ toolName: "read", input: { path: "nested/c" } }), undefined);
  assert.equal(gate.prompts, 1);
});

test("deny rules win over grants", async () => {
  const gate = mockGate("/work/project", ["For this session"], ["/secret"]);
  assert.equal(await gate.call({ toolName: "read", input: { path: "/secret/file" } }), "denied");
});

function mockGate(cwd: string, choices: Choice[] = [], denied: string[] = []) {
  const grants = new Set([cwd]);
  let prompts = 0;
  const call = async (event: Event) => {
    if (!["read", "write", "edit", "ls", "grep", "find"].includes(event.toolName)) return undefined;
    const value = String(event.input.path ?? event.input.root ?? event.input.directory ?? "");
    const candidates = isAbsolute(value)
      ? [normalize(value)]
      : [...grants].map((folder) => normalize(resolve(folder, value)));
    if (denied.some((folder) => candidates.some((path) => path === folder || path.startsWith(folder + "/")))) return "denied";
    if ([...grants].some((folder) => candidates.some((path) => path === folder || path.startsWith(folder + "/")))) return undefined;
    prompts++;
    const choice = choices[prompts - 1] ?? "No";
    if (choice === "For this session") grants.add(parentFolder(candidates[0]));
    return choice === "No" ? "denied" : prompts === 1 ? undefined : "prompt";
  };
  return { call, get prompts() { return prompts; } };
}
