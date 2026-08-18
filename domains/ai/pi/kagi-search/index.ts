import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";

const Parameters = Type.Object({
  query: Type.String({ description: "The web search query", minLength: 1 }),
});

export default function kagiSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "kagi_search",
    label: "Kagi Search",
    description: "Search the web with Kagi and return ranked results with titles, URLs, and snippets.",
    promptSnippet: "kagi_search — search the web",
    parameters: Parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return await new Promise((resolve) => {
        execFile("kagi-search", [params.query], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) resolve({ content: [{ type: "text", text: `Kagi search failed: ${stderr.trim() || error.message}` }], isError: true });
          else resolve({ content: [{ type: "text", text: stdout }] });
        });
      });
    },
  });
}
