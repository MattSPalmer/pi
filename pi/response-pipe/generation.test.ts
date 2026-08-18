import { test, expect } from "bun:test";
import {
  COMMAND_SYSTEM_PROMPT,
  CommandGenerationError,
  PiCommandGenerator,
  buildGenerationPrompt,
  createPiCommandGenerator,
  validateGeneratedCommand,
} from "./generation.ts";
import type { FailureInfo } from "./types.ts";

function completion(text: string, extra: Record<string, unknown> = {}): any {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    ...extra,
  };
}

test("generated commands accept shell syntax but reject prose and formatting", () => {
  expect(validateGeneratedCommand(" jq -r '.items[] | .name' > names.txt ")).toBe("jq -r '.items[] | .name' > names.txt");
  expect(validateGeneratedCommand("printf '%s\\n' \"$HOME\"" )).toBe("printf '%s\\n' \"$HOME\"");

  for (const invalid of [
    "",
    "```sh\ncat\n```",
    "Here is the command: cat",
    "I recommend using jq",
    "Command: cat",
    "cat\nwc -l",
    "cat\0",
  ]) {
    expect(() => validateGeneratedCommand(invalid)).toThrow(CommandGenerationError);
  }
});

test("repair prompts contain bounded, delimited diagnostics", () => {
  const failure: FailureInfo = {
    kind: "exit",
    command: "jq -r '.items[].name'",
    exitCode: 2,
    stderr: "bad input\n" + "x".repeat(20_000),
  };
  const prompt = buildGenerationPrompt("extract names", failure);
  expect(prompt).toContain("<pipe-request>\nextract names\n</pipe-request>");
  expect(prompt).toContain("Exit status: 2");
  expect(prompt).toContain("<previous-command>\njq -r '.items[].name'\n</previous-command>");
  expect(prompt).toContain("<previous-stderr>");
  expect(prompt).toContain("truncated");
  expect(prompt).toContain("Return only a corrected replacement command.");
  expect(buildGenerationPrompt("extract names")).toBe("<pipe-request>\nextract names\n</pipe-request>");
});

test("repair prompts identify policy denials as trusted local diagnostics", () => {
  const prompt = buildGenerationPrompt("use the permitted JSON tools", {
    kind: "denied",
    command: "git status",
    stderr: "",
    errorMessage: "Blocked by permission rule: git *\\nuse jj instead",
  });
  expect(prompt).toContain("Permission policy denial (trusted local policy)");
  expect(prompt).toContain("use jj instead");
});

test("PiCommandGenerator uses one isolated direct completion per request", async () => {
  const calls: any[] = [];
  const controller = new AbortController();
  const generator = new PiCommandGenerator({} as any, async (model, context, options) => {
    calls.push({ model, context, options });
    return completion("jq -r '.items[].name'");
  }, controller.signal);

  expect(await generator.generate("extract names")).toBe("jq -r '.items[].name'");
  expect(calls).toHaveLength(1);
  expect(calls[0].context.systemPrompt).toBe(COMMAND_SYSTEM_PROMPT);
  expect(calls[0].context.messages).toHaveLength(1);
  expect(calls[0].context.messages[0].content).toContain("extract names");
  expect(calls[0].context.tools).toBeUndefined();
  expect(calls[0].options.signal).toBe(controller.signal);
});

test("the Pi adapter delegates to ModelRegistry.complete without an agent turn", async () => {
  const calls: any[] = [];
  const generator = createPiCommandGenerator({
    model: {} as any,
    modelRegistry: {
      complete: async (...args: any[]) => {
        calls.push(args);
        return completion("cat");
      },
    },
  } as any);
  expect(await generator.generate("copy it")).toBe("cat");
  expect(calls).toHaveLength(1);
  expect(calls[0][1].tools).toBeUndefined();
});

test("PiCommandGenerator passes repair diagnostics and rejects unsuccessful completions", async () => {
  const prompts: string[] = [];
  const generator = new PiCommandGenerator({} as any, async (_model, context) => {
    prompts.push(String(context.messages[0].content));
    return completion("cat");
  });
  const failure: FailureInfo = {
    kind: "timeout",
    command: "sleep 1",
    stderr: "",
  };
  expect(await generator.generate("show it", failure)).toBe("cat");
  expect(prompts[0]).toContain("Failure kind: timeout");

  const badOutputs = [
    completion("", {}),
    completion("cat", { stopReason: "length" }),
    completion("cat", { errorMessage: "provider failed" }),
    { role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "stop" },
  ];
  for (const bad of badOutputs) {
    const badGenerator = new PiCommandGenerator({} as any, async () => bad as any);
    await expect(badGenerator.generate("show it")).rejects.toThrow(CommandGenerationError);
  }

  const noModel = new PiCommandGenerator(undefined, async () => completion("cat"));
  await expect(noModel.generate("show it")).rejects.toThrow("no active model");
});
