import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@mariozechner/pi-tui";
import { readPipeConfig, parsePipeInvocation } from "./config.ts";
import { evaluatePipePermissions } from "./permissions.ts";
import { runShellCommand, type CommandRunResult } from "./execution.ts";
import {
  CommandGenerationError,
  createPiCommandGenerator,
} from "./generation.ts";
import { latestResponse } from "./session.ts";
import {
  PIPE_RESPONSE_ENTRY,
  type FailureInfo,
  type PipeResponseEntry,
} from "./types.ts";

function messageText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && /aborted|cancelled/i.test(error.message));
}

function commandPreview(command: string, cwd: string, shell: string): string {
  return `Working directory: ${cwd}\nShell: ${shell}\n\nCommand:\n${command}\n\nThis command inherits the extension's environment and filesystem access.`;
}

function failureDescription(failure: FailureInfo, timeoutMs: number): string {
  let reason: string;
  switch (failure.kind) {
    case "timeout":
      reason = `timed out after ${timeoutMs} ms`;
      break;
    case "cancelled":
      reason = "cancelled";
      break;
    case "output_limit":
      reason = `exceeded the ${failure.outputLimit ?? "output"} limit`;
      break;
    case "signal":
      reason = `terminated by ${failure.signal ?? "an unknown signal"}`;
      break;
    case "spawn":
      reason = `could not start: ${failure.errorMessage ?? "unknown process error"}`;
      break;
    case "exit":
      reason = `exited with status ${failure.exitCode ?? "unknown"}`;
      break;
    case "denied":
      reason = `denied by the local permission policy: ${failure.errorMessage ?? "unspecified"}`;
      break;
  }

  const exitStatus = failure.exitCode !== undefined
    ? String(failure.exitCode)
    : failure.signal
      ? `signal ${failure.signal}`
      : "unavailable";
  const stderr = failure.stderr ? `\nstderr:\n${failure.stderr}` : "";
  const truncated = failure.stderrTruncated ? "\n[stderr truncated]" : "";
  return `Command failed (${reason}).\nExit status: ${exitStatus}\nCommand:\n${failure.command}${stderr}${truncated}`;
}

function showCommand(ctx: ExtensionCommandContext, command: string, cwd: string, shell: string): void {
  ctx.ui.notify(
    `response-pipe will run:\n${command}\n\nWorking directory: ${cwd}\nShell: ${shell}\n\nThis command inherits the extension's environment and filesystem access.`,
    "warning",
  );
}

async function withTerminalCancellation<T>(
  ctx: ExtensionCommandContext,
  controller: AbortController,
  operation: () => Promise<T>,
): Promise<T> {
  if (!ctx.hasUI) return operation();

  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (data === "\u0003" || data === "\u001b") {
      controller.abort();
      return { consume: true };
    }
    return undefined;
  });

  try {
    return await operation();
  } finally {
    unsubscribe();
  }
}

async function confirmCommand(
  ctx: ExtensionCommandContext,
  command: string,
  config: ReturnType<typeof readPipeConfig>,
  skipConfirmation: boolean,
  allowlistBasis?: string,
): Promise<boolean> {
  showCommand(ctx, command, ctx.cwd, config.shell);
  if (allowlistBasis) {
    ctx.ui.notify(`response-pipe command allowed by permission policy: ${allowlistBasis}`, "info");
    return true;
  }
  if (skipConfirmation || !config.confirm) return true;
  if (!ctx.hasUI) {
    ctx.ui.notify("Confirmation is required in non-interactive mode; use /pipe --yes or PI_RESPONSE_PIPE_CONFIRM=0.", "error");
    return false;
  }
  return ctx.ui.confirm("Run response-pipe command?", commandPreview(command, ctx.cwd, config.shell));
}

function installPipeResponseRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<PipeResponseEntry>(PIPE_RESPONSE_ENTRY, (entry, { expanded }, theme) => {
    if (!entry.data || entry.data.type !== "pipe_response") {
      return new Text(theme.fg("error", "Invalid response-pipe entry."), 0, 0);
    }

    const data = entry.data;
    const markdown = new Markdown(data.output.trim(), 1, 0, getMarkdownTheme(), {
      color: (text: string) => theme.fg("text", text),
    });
    if (!expanded) return markdown;

    const container = new Container();
    container.addChild(markdown);
    container.addChild(new Text(theme.fg("dim", `pipe: ${data.command}`), 1, 0));
    container.addChild(new Text(theme.fg("dim", data.timestamp), 1, 0));
    return container;
  });
}

export default function (pi: ExtensionAPI): void {
  installPipeResponseRenderer(pi);
  pi.registerFlag("pipe-no-confirm", {
    description: "Allow /pipe to execute without its confirmation prompt",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("pipe", {
    description: "Transform the latest response through a generated shell command",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const invocation = parsePipeInvocation(args);
      let request = invocation.request;
      if (!request) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /pipe <natural-language transformation request>", "warning");
          return;
        }
        const prompted = await ctx.ui.input(
          "Response-pipe transformation",
          "e.g. extract the names from the JSON and output one per line",
        );
        if (prompted === undefined) return;
        request = prompted.trim();
      }
      if (!request) {
        ctx.ui.notify("The /pipe transformation request cannot be empty.", "warning");
        return;
      }

      const response = latestResponse(ctx.sessionManager.getBranch());
      if (!response) {
        ctx.ui.notify("There is no previous assistant response to pipe.", "warning");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("There is no active model available for command generation.", "error");
        return;
      }

      const config = readPipeConfig();
      const skipConfirmation =
        invocation.skipConfirmation || pi.getFlag("pipe-no-confirm") === true;
      const controller = new AbortController();
      const inheritedSignal = ctx.signal;
      const inheritAbort = (): void => controller.abort();
      if (inheritedSignal) {
        inheritedSignal.addEventListener("abort", inheritAbort, { once: true });
        if (inheritedSignal.aborted) controller.abort();
      }

      const generator = createPiCommandGenerator(ctx, controller.signal);

      let failure: FailureInfo | undefined;
      let repairAttempts = 0;
      try {
        while (true) {
          let command: string;
          try {
            ctx.ui.setStatus("response-pipe", "generating shell command…");
            command = await withTerminalCancellation(ctx, controller, () =>
              generator.generate(request, failure),
            );
          } catch (error) {
            if (isCancellation(error, controller.signal)) {
              ctx.ui.notify("response-pipe command generation cancelled.", "info");
            } else {
              const detail = error instanceof CommandGenerationError ? error.message : messageText(error);
              ctx.ui.notify(`response-pipe could not generate a command: ${detail}`, "error");
            }
            return;
          } finally {
            ctx.ui.setStatus("response-pipe", undefined);
          }

          let result: CommandRunResult;
          const policy = config.permissions
            ? evaluatePipePermissions({
                command,
                cwd: ctx.cwd,
                sessionEntries: ctx.sessionManager.getEntries(),
              })
            : undefined;
          if (policy?.verdict === "deny") {
            const denied: FailureInfo = {
              kind: "denied",
              command,
              stderr: "",
              errorMessage: policy.reason,
            };
            result = { ok: false, stdout: "", stderr: "", failure: denied };
          } else {
            const confirmed = await confirmCommand(
              ctx,
              command,
              config,
              skipConfirmation,
              policy?.verdict === "allow" ? policy.basis : undefined,
            );
            if (!confirmed) {
              ctx.ui.notify("response-pipe command not run; the previous response is unchanged.", "info");
              return;
            }

            try {
              ctx.ui.setStatus("response-pipe", "running shell command…");
              result = await withTerminalCancellation(ctx, controller, () =>
                runShellCommand(command, response.text, {
                  shell: config.shell,
                  cwd: ctx.cwd,
                  env: process.env,
                  timeoutMs: config.timeoutMs,
                  maxStdoutBytes: config.maxStdoutBytes,
                  maxStderrBytes: config.maxStderrBytes,
                  signal: controller.signal,
                }),
              );
            } catch (error) {
              if (isCancellation(error, controller.signal)) {
                ctx.ui.notify("response-pipe command cancelled; the previous response is unchanged.", "info");
              } else {
                ctx.ui.notify(`response-pipe execution failed: ${messageText(error)}`, "error");
              }
              return;
            } finally {
              ctx.ui.setStatus("response-pipe", undefined);
            }
          }

          if (result.ok) {
            const entry: PipeResponseEntry = {
              type: "pipe_response",
              request,
              command,
              inputResponseId: response.responseId,
              output: result.stdout,
              exitCode: 0,
              timestamp: new Date().toISOString(),
            };
            pi.appendEntry(PIPE_RESPONSE_ENTRY, entry);
            if (result.stderr) {
              ctx.ui.notify(`response-pipe command wrote to stderr:\n${result.stderr}`, "warning");
            }
            return;
          }

          if (result.failure.kind === "cancelled") {
            ctx.ui.notify("response-pipe command cancelled; the previous response is unchanged.", "info");
            return;
          }

          failure = result.failure;
          if (repairAttempts >= config.maxRepairAttempts) {
            ctx.ui.notify(
              `${failureDescription(result.failure, config.timeoutMs)}\n\nNo repair attempts remain. The previous response is unchanged.`,
              "error",
            );
            return;
          }

          repairAttempts += 1;
          ctx.ui.notify(
            `${failureDescription(result.failure, config.timeoutMs)}\nAsking the model for repair ${repairAttempts}/${config.maxRepairAttempts}…`,
            "warning",
          );
        }
      } finally {
        if (inheritedSignal) inheritedSignal.removeEventListener("abort", inheritAbort);
        ctx.ui.setStatus("response-pipe", undefined);
      }
    },
  });
}
