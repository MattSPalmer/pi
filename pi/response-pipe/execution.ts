import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { FailureInfo } from "./types.ts";

export interface ShellExecutionOptions {
  shell: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
  /** Injectable for unit tests; normal callers use child_process.spawn. */
  spawnProcess?: SpawnProcess;
}

export type SpawnProcess = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => ChildProcessWithoutNullStreams;

export interface CommandRunSuccess {
  ok: true;
  stdout: string;
  stderr: string;
  exitCode: 0;
}

export interface CommandRunFailure {
  ok: false;
  stdout: string;
  stderr: string;
  failure: FailureInfo;
}

export type CommandRunResult = CommandRunSuccess | CommandRunFailure;
type TerminationReason = "timeout" | "cancelled" | "output_limit";

function asBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function bytesToString(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

function failed(
  command: string,
  stdout: Buffer[],
  stderr: Buffer[],
  failure: FailureInfo,
): CommandRunFailure {
  return {
    ok: false,
    stdout: bytesToString(stdout),
    stderr: bytesToString(stderr),
    failure,
  };
}

/**
 * Run a generated command with the response in a pipe. The response is never
 * put into the command string; it is written to the child stdin as UTF-8.
 */
export async function runShellCommand(
  command: string,
  input: string,
  options: ShellExecutionOptions,
): Promise<CommandRunResult> {
  const baseFailure = (kind: FailureInfo["kind"], extra: Partial<FailureInfo> = {}): CommandRunFailure =>
    failed(command, [], [], {
      kind,
      command,
      stderr: "",
      ...extra,
    });

  if (options.signal?.aborted) return baseFailure("cancelled");

  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawnProcess ?? spawn)(options.shell, ["-c", command], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return baseFailure("spawn", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  return new Promise<CommandRunResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrTruncated = false;
    let outputLimit: "stdout" | "stderr" | undefined;
    let termination: TerminationReason | undefined;
    let processError: Error | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have exited between the output/abort event and kill.
      }
    };

    const terminate = (reason: TerminationReason): void => {
      if (termination) return;
      termination = reason;
      kill();
      // A shell can have descendants holding stdout/stderr open. Escalate and
      // close our streams so timeout/limit failures cannot wait forever.
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already be gone.
        }
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
      }, 250);
    };

    const onAbort = (): void => terminate("cancelled");
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (result: CommandRunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const failureForClose = (code: number | null, signal: NodeJS.Signals | null): CommandRunFailure => {
      let kind: FailureInfo["kind"];
      if (termination === "output_limit") kind = "output_limit";
      else if (termination === "timeout") kind = "timeout";
      else if (termination === "cancelled") kind = "cancelled";
      else if (processError) kind = "spawn";
      else if (signal) kind = "signal";
      else kind = "exit";

      return failed(command, stdout, stderr, {
        kind,
        command,
        exitCode: code === null ? undefined : code,
        signal: signal ?? undefined,
        stderr: bytesToString(stderr),
        stderrTruncated,
        outputLimit,
        errorMessage: processError?.message,
      });
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled || outputLimit) return;
      const data = asBuffer(chunk);
      const remaining = options.maxStdoutBytes - stdoutBytes;
      if (data.byteLength > remaining) {
        if (remaining > 0) stdout.push(data.subarray(0, remaining));
        stdoutBytes = Math.max(stdoutBytes, options.maxStdoutBytes);
        outputLimit = "stdout";
        terminate("output_limit");
        return;
      }
      stdout.push(data);
      stdoutBytes += data.byteLength;
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      if (settled || outputLimit) return;
      const data = asBuffer(chunk);
      const remaining = options.maxStderrBytes - stderrBytes;
      if (data.byteLength > remaining) {
        if (remaining > 0) stderr.push(data.subarray(0, remaining));
        stderrBytes = Math.max(stderrBytes, options.maxStderrBytes);
        stderrTruncated = true;
        outputLimit = "stderr";
        terminate("output_limit");
        return;
      }
      stderr.push(data);
      stderrBytes += data.byteLength;
    });

    child.on("error", (error) => {
      processError = error;
    });

    child.on("close", (code, signal) => {
      if (termination || processError || signal || code !== 0) {
        finish(failureForClose(code, signal));
      } else {
        finish({
          ok: true,
          stdout: bytesToString(stdout),
          stderr: bytesToString(stderr),
          exitCode: 0,
        });
      }
    });

    // A command that exits before consuming stdin can produce EPIPE. It is a
    // property of that command, not a reason to interpolate or alter the input.
    child.stdin.on("error", () => {});
    try {
      child.stdin.end(Buffer.from(input, "utf8"));
    } catch (error) {
      processError = error instanceof Error ? error : new Error(String(error));
      kill();
    }

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }
    timer = setTimeout(() => terminate("timeout"), Math.max(0, options.timeoutMs));
  });
}
