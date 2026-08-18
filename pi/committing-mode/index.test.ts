import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConsumers, targetWorkspace, taskRangeRevset } from "./index.ts";

const original = process.env.PI_COMMITTING_WORKSPACE;
try {
  delete process.env.PI_COMMITTING_WORKSPACE;
  assert.equal(targetWorkspace("/tmp/polyrepo"), "/tmp/polyrepo");

  process.env.PI_COMMITTING_WORKSPACE = "marketplace";
  assert.equal(targetWorkspace("/tmp/polyrepo"), "/tmp/polyrepo/marketplace");

  process.env.PI_COMMITTING_WORKSPACE = "/work/marketplace";
  assert.equal(targetWorkspace("/tmp/polyrepo"), "/work/marketplace");
  assert.deepEqual(parseConsumers("marketplace\n/work/other\n", "/tmp/polyrepo"), [
    "/tmp/polyrepo/marketplace",
    "/work/other",
  ]);
  assert.equal(taskRangeRevset("kxyz1234"), "(kxyz1234::@) & mutable()");

  // Regression: jj templates treat single-quoted strings as raw, so a `'\\n'`
  // separator appended a literal backslash-n to every parsed id. That polluted
  // change id was interpolated into the task-range revset, which then failed to
  // parse, so committing mode silently described nothing while the next turn's
  // dirty-separation still created a change. Templates must use double quotes.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.equal(
    /\+\+ '\\\\n'/.test(source),
    false,
    "jj templates must not use raw single-quoted '\\n' separators",
  );
  assert.ok(/change_id \+\+ "\\\\n"/.test(source), "change_id template must use a double-quoted newline");
  // The revset must never receive an id containing a backslash escape.
  assert.ok(!taskRangeRevset("kxyz1234\\n").includes("kxyz1234::"), "sanity: polluted ids break the revset");
} finally {
  if (original === undefined) delete process.env.PI_COMMITTING_WORKSPACE;
  else process.env.PI_COMMITTING_WORKSPACE = original;
}
