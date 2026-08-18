import { test, expect } from "bun:test";
import { runShellCommand } from "./execution.ts";

const options = {
  shell: "/bin/sh",
  cwd: process.cwd(),
  timeoutMs: 1_000,
  maxStdoutBytes: 64 * 1024,
  maxStderrBytes: 64 * 1024,
};

test("shell execution passes response only through stdin and preserves stdout", async () => {
  const input = "quotes: '$HOME' && $(touch should-not-run) | `backticks`\n";
  const result = await runShellCommand("cat", input, options);
  expect(result).toEqual({ ok: true, stdout: input, stderr: "", exitCode: 0 });

  const syntax = await runShellCommand("printf '%s' 'a b' | tr ' ' '_' > /dev/stdout", "ignored", options);
  expect(syntax.ok).toBe(true);
  expect(syntax.stdout).toBe("a_b");
});

test("successful stderr is separate and trailing newlines are exact", async () => {
  const result = await runShellCommand("printf 'diagnostic\\n' >&2; printf 'one\\ntwo\\n'", "", options);
  expect(result).toEqual({ ok: true, stdout: "one\ntwo\n", stderr: "diagnostic\n", exitCode: 0 });

  const noNewline = await runShellCommand("printf 'one'", "", options);
  expect(noNewline.ok && noNewline.stdout).toBe("one");
});

test("non-zero exit is a failure even when stderr is empty", async () => {
  const result = await runShellCommand("exit 7", "original", options);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.kind).toBe("exit");
    expect(result.failure.exitCode).toBe(7);
    expect(result.failure.stderr).toBe("");
  }
});

test("a repair receives the original response rather than partial failed stdout", async () => {
  const original = "needle-free response with $HOME and $(not executed)";
  const failed = await runShellCommand("printf 'partial'; grep '^NEVER_PRESENT$'", original, options);
  expect(failed.ok).toBe(false);
  const repaired = await runShellCommand("cat", original, options);
  expect(repaired).toEqual({ ok: true, stdout: original, stderr: "", exitCode: 0 });
});

test("signal termination, timeout, cancellation, and output limits are distinguishable", async () => {
  const signaled = await runShellCommand("kill -TERM $$", "", options);
  expect(signaled.ok).toBe(false);
  if (!signaled.ok) expect(signaled.failure.kind).toBe("signal");

  const timedOut = await runShellCommand("sleep 1", "", { ...options, timeoutMs: 10 });
  expect(timedOut.ok).toBe(false);
  if (!timedOut.ok) expect(timedOut.failure.kind).toBe("timeout");

  const controller = new AbortController();
  const running = runShellCommand("sleep 1", "", { ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const cancelled = await running;
  expect(cancelled.ok).toBe(false);
  if (!cancelled.ok) expect(cancelled.failure.kind).toBe("cancelled");

  const stdoutLimit = await runShellCommand("head -c 1024 /dev/zero", "", {
    ...options,
    maxStdoutBytes: 8,
  });
  expect(stdoutLimit.ok).toBe(false);
  if (!stdoutLimit.ok) {
    expect(stdoutLimit.failure.kind).toBe("output_limit");
    expect(stdoutLimit.failure.outputLimit).toBe("stdout");
  }

  const stderrLimit = await runShellCommand("head -c 1024 /dev/zero >&2", "", {
    ...options,
    maxStderrBytes: 8,
  });
  expect(stderrLimit.ok).toBe(false);
  if (!stderrLimit.ok) {
    expect(stderrLimit.failure.kind).toBe("output_limit");
    expect(stderrLimit.failure.outputLimit).toBe("stderr");
    expect(stderrLimit.failure.stderrTruncated).toBe(true);
  }
});

test("spawn errors and pre-cancelled commands do not execute", async () => {
  const spawnError = await runShellCommand("cat", "input", {
    ...options,
    shell: "/definitely/not-a-shell",
  });
  expect(spawnError.ok).toBe(false);
  if (!spawnError.ok) expect(spawnError.failure.kind).toBe("spawn");

  const controller = new AbortController();
  controller.abort();
  const cancelled = await runShellCommand("cat", "input", { ...options, signal: controller.signal });
  expect(cancelled.ok).toBe(false);
  if (!cancelled.ok) expect(cancelled.failure.kind).toBe("cancelled");
});
