import { test, expect } from "bun:test";
import {
  assistantText,
  isPipeResponseEntry,
  latestResponse,
} from "./session.ts";

test("assistantText joins only text blocks and preserves empty text", () => {
  expect(assistantText({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "one" },
      { type: "toolCall", name: "cat" },
      { type: "text", text: " two" },
    ],
  })).toBe("one two");
  expect(assistantText({ role: "assistant", content: [{ type: "text", text: "" }] })).toBe("");
  expect(assistantText({ role: "assistant", content: "plain" })).toBe("plain");
  expect(assistantText({ role: "user", content: "not assistant" })).toBeUndefined();
  expect(assistantText({ role: "assistant", content: [{ type: "thinking", thinking: "only" }] })).toBeUndefined();
  expect(assistantText(null)).toBeUndefined();
});

const pipeData = {
  type: "pipe_response" as const,
  request: "extract names",
  command: "jq -r '.items[].name'",
  inputResponseId: "assistant-1",
  output: "Ada\nGrace\n",
  exitCode: 0 as const,
  timestamp: "2026-08-18T00:00:00.000Z",
};

test("pipe response entries are validated and chain as the current response", () => {
  expect(isPipeResponseEntry(pipeData)).toBe(true);
  expect(isPipeResponseEntry({ ...pipeData, exitCode: 1 })).toBe(false);
  expect(isPipeResponseEntry({ ...pipeData, output: 12 })).toBe(false);

  expect(latestResponse([
    {
      type: "message",
      id: "assistant-1",
      message: { role: "assistant", content: [{ type: "text", text: "{\"items\":[]}" }] },
    },
    { type: "custom", id: "pipe-1", customType: "pipe_response", data: pipeData },
  ])).toEqual({ text: "Ada\nGrace\n", responseId: "pipe-1" });
});

test("latestResponse skips malformed pipe entries and non-text assistants", () => {
  expect(latestResponse([
    { type: "message", id: "tool-only", message: { role: "assistant", content: [{ type: "toolCall" }] } },
    { type: "custom", customType: "pipe_response", data: { ...pipeData, output: 42 } },
    { type: "message", id: "assistant-2", message: { role: "assistant", content: [{ type: "text", text: "fallback" }] } },
  ])).toEqual({ text: "fallback", responseId: "assistant-2" });
  expect(latestResponse([])).toBeUndefined();
});
