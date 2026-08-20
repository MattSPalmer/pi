import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Make the transcript's "top" action easy to discover after a long reply.
 *
 * Scrolling is owned by pi's fullscreen transcript, rather than by an
 * extension UI component. The actual shortcut is therefore configured in
 * keybindings.json (tui.altScreen.top). This extension provides a command
 * for users in non-fullscreen mode and a useful hint when a long response
 * arrives.
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("response-top", {
    description: "Show the shortcut for scrolling the transcript to the top",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Press Shift+Space to scroll the transcript to the top (fullscreen mode).",
        "info",
      );
    },
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const content = event.message.content;
    const text = Array.isArray(content)
      ? content
          .filter(
            (part): part is { type: "text"; text: string } =>
              !!part &&
              typeof part === "object" &&
              (part as { type?: string }).type === "text" &&
              typeof (part as { text?: unknown }).text === "string",
          )
          .map((part) => part.text)
          .join("")
      : "";
    if (text.split("\n").length > 40) {
      ctx.ui.setStatus("response-scroll", "Long response · Shift+Space: top");
    } else {
      ctx.ui.setStatus("response-scroll", "");
    }
  });
}
