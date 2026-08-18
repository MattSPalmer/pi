import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const pendingFoldKey = "__sesseract_pending_fold__";

type PendingFold = { answer: string };

function getPendingFold(): PendingFold | undefined {
  return (globalThis as Record<string, unknown>)[pendingFoldKey] as PendingFold | undefined;
}

function setPendingFold(value: PendingFold | undefined): void {
  if (value) (globalThis as Record<string, unknown>)[pendingFoldKey] = value;
  else delete (globalThis as Record<string, unknown>)[pendingFoldKey];
}

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Entry = {
  id: string;
  message?: {
    role: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
};

export function textOf(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

export function label(text: string, index: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const preview = oneLine.length > 100 ? `${oneLine.slice(0, 97)}...` : oneLine;
  return `${index + 1}. ${preview || "(empty message)"}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "fork") return;
    const pending = getPendingFold();
    if (!pending) return;

    try {
      const model = ctx.model as any;
      await ctx.sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: pending.answer }],
        api: model?.api ?? "unknown",
        provider: model?.provider ?? "unknown",
        model: model?.id ?? model?.model ?? "unknown",
        usage: zeroUsage,
        stopReason: "stop",
        details: { sesseract: true, source: "previous-session" },
        timestamp: Date.now(),
      } as any);
      setPendingFold(undefined);
      ctx.ui.notify("Folded into a new session.", "info");
    } catch (error) {
      ctx.ui.notify(`Could not append folded answer: ${String(error)}`, "error");
    }
  });

  for (const [command, foldAll] of [["fold", false], ["fold-all", true]] as const) {
    pi.registerCommand(command, {
      description: foldAll
        ? "Fork from a user message and preserve the complete subsequent turn"
        : "Fork from a user message and preserve the current answer as its content",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();

        const branch = ctx.sessionManager.getBranch() as Entry[];
        const userEntries = branch.filter((entry) => entry.message?.role === "user");
        const latestAssistant = [...branch].reverse().find((entry) => entry.message?.role === "assistant");

        if (!latestAssistant) {
          ctx.ui.notify("There is no assistant answer to fold.", "error");
          return;
        }
        if (userEntries.length === 0) {
          ctx.ui.notify("There are no user messages to fold from.", "error");
          return;
        }

        const selected = await ctx.ui.select(
          "Fold from which user message?",
          userEntries.map((entry, index) => label(textOf(entry.message?.content), index)),
        );
        if (!selected) return;

        const selectedIndex = userEntries.findIndex(
          (_entry, index) => label(textOf(userEntries[index].message?.content), index) === selected,
        );
        const source = userEntries[selectedIndex];
        if (!source) return;

        const answer = textOf(latestAssistant.message?.content);
        if (!answer) {
          ctx.ui.notify("The latest assistant answer has no text content.", "error");
          return;
        }

        const sourceIndex = branch.findIndex((entry) => entry.id === source.id);
        const prefix = branch.slice(0, sourceIndex + 1).filter((entry) => entry.message).map((entry) => entry.message as any);
        const parentSession = ctx.sessionManager.getSessionFile();
        const currentModel = ctx.model as any;
        const assistantMetadata = {
          api: currentModel?.api ?? "unknown",
          provider: currentModel?.provider ?? "unknown",
          model: currentModel?.id ?? currentModel?.model ?? "unknown",
        };
        const foldedMessages = foldAll
          ? branch.slice(sourceIndex + 1).filter((entry) => entry.message).map((entry) => entry.message as any)
          : [{ role: "assistant", content: [{ type: "text", text: answer }], ...assistantMetadata, usage: zeroUsage, stopReason: "stop", timestamp: Date.now() }];

        const result = await ctx.newSession({
          parentSession,
          setup: async (sm) => {
            for (const message of prefix) await sm.appendMessage(message);
            for (const message of foldedMessages) {
              await sm.appendMessage({ ...message, ...(message.role === "assistant" ? assistantMetadata : {}), timestamp: Date.now() } as any);
            }
          },
          withSession: async (replacementCtx) => replacementCtx.ui.notify("Folded into a new session.", "info"),
        });

        if (result.cancelled) ctx.ui.notify("Fold cancelled.", "info");
      },
    });
  }
}
