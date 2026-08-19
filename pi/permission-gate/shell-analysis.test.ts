import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const analyzerDir = mkdtempSync(join(tmpdir(), "permission-gate-analyzer-"));
const analyzerPath = join(analyzerDir, "analyzer.sh");
writeFileSync(analyzerPath, `#!/bin/sh
case "$1" in
  malformed) printf '%s\\n' '{"status":"ok","commands":[{"argv":["cat",1]}]}' ;;
  empty) printf '%s\\n' '{"status":"error"}' ;;
  invalid) printf '%s\\n' 'not json' ;;
  *) printf '%s\\n' '{"status":"ok","commands":[{"argv":["/usr/bin/cat","-n","./a","./a"],"redirects":["out.txt","out.txt"]},{"argv":["jj","diff"],"redirects":[]}]}' ;;
esac
`);
chmodSync(analyzerPath, 0o755);
const previousAnalyzer = process.env.PI_PERMISSION_ANALYZER;
process.env.PI_PERMISSION_ANALYZER = analyzerPath;
const { analyzeWithRust, looksLikePath, tokenizeSimpleShell } = await import("./shell-analysis");
after(() => {
  if (previousAnalyzer === undefined) delete process.env.PI_PERMISSION_ANALYZER;
  else process.env.PI_PERMISSION_ANALYZER = previousAnalyzer;
});

test("fallback tokenizer rejects every compound separator", () => {
  for (const separator of ["|", "&&", "||", ";"]) {
    const result = tokenizeSimpleShell(`echo ok ${separator} rm /tmp/file`);
    assert.equal(result.safe, false, `separator ${separator} must be opaque`);
  }
});

test("fallback tokenizer rejects opaque interpreters", () => {
  for (const interpreter of ["sh", "bash", "python3", "node", "xargs"]) {
    const result = tokenizeSimpleShell(`${interpreter} -c 'echo unsafe'`);
    assert.equal(result.safe, false, `${interpreter} must be opaque`);
  }
});

test("path heuristic distinguishes paths from ordinary arguments", () => {
  const cases: Array<[string, boolean]> = [
    ["/", true],
    ["/tmp/file", true],
    ["~/config", true],
    ["~", true],
    ["./file", true],
    ["../file", true],
    ["..", true],
    ["a/b", true],
    ["README.md", false],
    ["word", false],
    ["--flag", false],
    ["https://example.com", true],
    ["a\\\\b", false],
    [".../file", false],
    ["~user/file", false],
  ];
  for (const [value, expected] of cases) {
    assert.equal(looksLikePath(value), expected, value);
  }
});

test("fallback tokenizer extracts path-bearing arguments", () => {
  const result = tokenizeSimpleShell("cp ./source.txt /tmp/destination.txt");
  assert.equal(result.safe, true);
  if (result.safe) assert.deepEqual(result.paths, ["./source.txt", "/tmp/destination.txt"]);
});

test("fallback tokenizer preserves quoted literal arguments", () => {
  const result = tokenizeSimpleShell("echo 'hello world'");
  assert.equal(result.safe, true);
  if (result.safe) assert.deepEqual(result.tokens, ["echo", "hello world"]);
});

test("Rust analyzer output is normalized and deduplicated", () => {
  const result = analyzeWithRust("ok");
  assert.deepEqual(result, {
    safe: true,
    tokens: ["/usr/bin/cat", "-n", "./a", "./a", "jj", "diff"],
    paths: ["./a", "diff"],
    commands: ["/usr/bin/cat -n ./a ./a", "jj diff"],
    commandArgv: [["/usr/bin/cat", "-n", "./a", "./a"], ["jj", "diff"]],
    heads: ["cat", "jj"],
    redirects: ["out.txt"],
  });
});

test("Rust analyzer rejects bad, empty, and unavailable results", () => {
  assert.deepEqual(analyzeWithRust("malformed"), {
    safe: false,
    reason: "analyzer returned a malformed command list",
  });
  assert.deepEqual(analyzeWithRust("empty"), { safe: false, reason: "opaque shell syntax" });
  const invalid = analyzeWithRust("invalid");
  assert.equal(invalid.safe, false);
  if (!invalid.safe) assert.match(invalid.reason, /Rust shell analyzer unavailable or failed/);
});
