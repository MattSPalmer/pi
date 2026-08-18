import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Params = Type.Object({
  path: Type.Optional(Type.String({ description: "The file or directory the agent wants to access" })),
  command: Type.Optional(Type.String({ description: "A Bash command pattern; a trailing * matches any remaining arguments" })),
  reason: Type.Optional(Type.String({ description: "Why this temporary access is needed" })),
});

const ENTRY = "permission-gate-path-grant";

export default function proposePermission(pi: ExtensionAPI) {
  pi.registerTool({
    name: "propose_permission",
    label: "Propose permission",
    description: "Ask the user to approve access to a directory for the rest of this session. This never grants access without explicit user approval.",
    promptSnippet: "propose_permission — request temporary session access to a path",
    parameters: Params,
    executionMode: "sequential",
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const path = String(params.path ?? "").trim();
      const command = String(params.command ?? "").trim();
      if ((path && command) || (!path && !command)) {
        return { content: [{ type: "text", text: "Permission proposal rejected: provide exactly one of path or command." }], isError: true };
      }
      const value = path || command;
      if (value.includes("\0") || value.length > 4096) {
        return { content: [{ type: "text", text: "Permission proposal rejected: invalid permission value." }], isError: true };
      }
      if (command && !command.endsWith("*")) {
        return { content: [{ type: "text", text: "Permission proposal rejected: command must end with * to approve a bounded command prefix." }], isError: true };
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        return { content: [{ type: "text", text: "Permission proposal rejected: interactive approval is unavailable." }], isError: true };
      }
      const reason = params.reason ? `\n\nReason: ${String(params.reason).slice(0, 1000)}` : "";
      const choice = await ctx.ui.select(
        `Allow temporary access for this session?\n\n  ${command ? `Bash: ${command}` : `Path: ${path}`}${reason}`,
        ["Allow for this session", "No"],
      );
      if (choice !== "Allow for this session") {
        return { content: [{ type: "text", text: "User did not approve the permission proposal." }], details: { approved: false } };
      }
      pi.appendEntry(ENTRY, command ? { command } : { path });
      return { content: [{ type: "text", text: `Approved for this session: ${value}` }], details: { approved: true, path: path || undefined, command: command || undefined } };
    },
  });
}
