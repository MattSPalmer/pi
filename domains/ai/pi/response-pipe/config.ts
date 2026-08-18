export const DEFAULT_PIPE_CONFIG = {
  shell: "/bin/sh",
  timeoutMs: 30_000,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 256 * 1024,
  maxRepairAttempts: 2,
  confirm: true,
  permissions: true,
} as const;

export interface PipeConfig {
  shell: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxRepairAttempts: number;
  confirm: boolean;
  permissions: boolean;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function falseValue(value: string | undefined): boolean {
  return value !== undefined && /^(?:0|false|no|off)$/i.test(value.trim());
}

/**
 * Read process-level configuration. Environment variables are deliberately
 * explicit because this extension executes arbitrary shell commands.
 *
 * PI_RESPONSE_PIPE_CONFIRM=0 (or false/no/off) disables the confirmation
 * prompt. The command's --yes/-y/--no-confirm switches are one-shot overrides.
 */
export function readPipeConfig(env: Record<string, string | undefined> = process.env): PipeConfig {
  const shell = env.PI_RESPONSE_PIPE_SHELL?.trim() || DEFAULT_PIPE_CONFIG.shell;
  return {
    shell,
    timeoutMs: positiveInteger(env.PI_RESPONSE_PIPE_TIMEOUT_MS, DEFAULT_PIPE_CONFIG.timeoutMs),
    maxStdoutBytes: positiveInteger(
      env.PI_RESPONSE_PIPE_MAX_STDOUT_BYTES,
      DEFAULT_PIPE_CONFIG.maxStdoutBytes,
    ),
    maxStderrBytes: positiveInteger(
      env.PI_RESPONSE_PIPE_MAX_STDERR_BYTES,
      DEFAULT_PIPE_CONFIG.maxStderrBytes,
    ),
    maxRepairAttempts: nonNegativeInteger(
      env.PI_RESPONSE_PIPE_MAX_REPAIR_ATTEMPTS,
      DEFAULT_PIPE_CONFIG.maxRepairAttempts,
    ),
    confirm: !falseValue(env.PI_RESPONSE_PIPE_CONFIRM) && !falseValue(env.PI_RESPONSE_PIPE_NO_CONFIRM),
    permissions: !falseValue(env.PI_RESPONSE_PIPE_PERMISSIONS),
  };
}

export interface PipeInvocation {
  request: string;
  skipConfirmation: boolean;
}

/** Parse only explicit leading command switches; the rest remains natural language. */
export function parsePipeInvocation(args: string | undefined): PipeInvocation {
  let request = (args ?? "").trim();
  let skipConfirmation = false;

  while (request.length > 0) {
    const match = request.match(/^(--yes|--no-confirm|-y)(?:\s+|$)/);
    if (match) {
      skipConfirmation = true;
      request = request.slice(match[0].length).trim();
      continue;
    }

    if (request === "--" || request.startsWith("-- ")) {
      request = request.slice(2).trim();
    }
    break;
  }

  return { request, skipConfirmation };
}
