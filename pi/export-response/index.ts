import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type TextPart = { type: "text"; text: string };
type AssistantMessage = { role: "assistant"; content: unknown };

let lastResponse = "";

export function responseText(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is TextPart =>
      !!part && typeof part === "object" && (part as TextPart).type === "text" && typeof (part as TextPart).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export function destination(guidance: string): string {
  const text = guidance.trim().replace(/^['"]|['"]$/g, "");
  // The common/useful form is simply `/write-response docs/design.md`.
  // Backticks make paths unambiguous when guidance is prose.
  const path = text.match(/`([^`]+)`/)?.[1] ?? (text.includes("/") || /\.[A-Za-z0-9]+$/.test(text) ? text : "");
  if (path) return path;
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `.pi/responses/${slug || `response-${Date.now()}`}.md`;
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event) => {
    if (event.message.role === "assistant") {
      const text = responseText(event.message as AssistantMessage);
      if (text) lastResponse = text;
    }
  });

  pi.registerCommand("write-response", {
    description: "Write the last assistant response to a new file in the current project",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      if (!lastResponse) {
        ctx.ui.notify("There is no assistant response to write.", "warning");
        return;
      }

      const requested = destination(args ?? "");
      const root = normalize(ctx.cwd);
      const target = normalize(isAbsolute(requested) ? requested : join(root, requested));
      const outside = relative(root, target).startsWith("..") || isAbsolute(relative(root, target));
      if (outside) {
        ctx.ui.notify("Refusing to write outside the current project.", "error");
        return;
      }

      await mkdir(dirname(target), { recursive: true });
      try {
        // `wx` makes the no-overwrite guarantee atomic, including concurrent
        // invocations of the command.
        await writeFile(target, lastResponse.endsWith("\n") ? lastResponse : `${lastResponse}\n`, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          ctx.ui.notify(`Refusing to overwrite existing file: ${relative(root, target)}`, "warning");
          return;
        }
        throw error;
      }
      ctx.ui.notify(`Wrote last response to ${relative(root, target)}`, "info");
    },
  });
}
