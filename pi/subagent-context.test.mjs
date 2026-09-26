import assert from "node:assert/strict";
import { injectContext } from "./subagent-context.mjs";

assert.equal(injectContext("task", undefined), "task");
assert.equal(injectContext("task", "/tmp/x", () => "[1]"), "task\n\nInjected context from /tmp/x:\n[1]");
assert.throws(() => injectContext("task", "/missing", () => { throw new Error("ENOENT"); }), /Could not read context file \/missing/);
assert.equal(injectContext("task", "/tmp/x", () => ""), "task\n\nInjected context from /tmp/x:\n");
console.log("subagent context tests passed");
