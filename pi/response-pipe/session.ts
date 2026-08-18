import {
  PIPE_RESPONSE_ENTRY,
  type PipeResponseEntry,
} from "./types.ts";

export interface LatestResponse {
  text: string;
  responseId?: string;
}

interface SessionEntryLike {
  type?: unknown;
  id?: unknown;
  message?: unknown;
  customType?: unknown;
  data?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Return assistant text while preserving text blocks (including an empty one). */
export function assistantText(message: unknown): string | undefined {
  const value = record(message);
  if (!value || value.role !== "assistant") return undefined;

  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return undefined;

  let foundText = false;
  const text = value.content
    .filter((part) => {
      const block = record(part);
      const isText = block?.type === "text" && typeof block.text === "string";
      if (isText) foundText = true;
      return isText;
    })
    .map((part) => (part as { text: string }).text)
    .join("");

  return foundText ? text : undefined;
}

export function isPipeResponseEntry(value: unknown): value is PipeResponseEntry {
  const entry = record(value);
  return (
    entry?.type === "pipe_response" &&
    typeof entry.request === "string" &&
    typeof entry.command === "string" &&
    typeof entry.output === "string" &&
    entry.exitCode === 0 &&
    typeof entry.timestamp === "string" &&
    (entry.inputResponseId === undefined || typeof entry.inputResponseId === "string")
  );
}

/**
 * Find the current response on the active branch. A successful pipe entry is
 * intentionally considered a response even though it is a custom entry and
 * therefore is not sent to the normal agent context.
 */
export function latestResponse(entries: readonly SessionEntryLike[]): LatestResponse | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === PIPE_RESPONSE_ENTRY && isPipeResponseEntry(entry.data)) {
      return {
        text: entry.data.output,
        responseId: typeof entry.id === "string" ? entry.id : undefined,
      };
    }

    if (entry?.type === "message") {
      const text = assistantText(entry.message);
      if (text !== undefined) {
        return {
          text,
          responseId: typeof entry.id === "string" ? entry.id : undefined,
        };
      }
    }
  }

  return undefined;
}
