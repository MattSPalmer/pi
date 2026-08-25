import {
  buildContextEntries as buildContextEntriesFromEntries,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Text } from "@mariozechner/pi-tui";

const pendingFoldKey = "__sesseract_pending_fold__";
const pendingReloadNoticeKey = "__sesseract_pending_reload_notice__";
const sessionFilterPatchKey = Symbol.for("sesseract.session-filter-patch");
const FOLD_ENTRY = "sesseract-fold";

type PendingFold = { answer: string };

type FoldMarkerData = {
  kind: "start" | "end";
  foldId: string;
  hiddenEntryIds?: string[];
  messageCount?: number;
  sourceEntryId?: string;
};

type FoldRecord = {
  foldId: string;
  startEntryId: string;
  endEntryId: string;
  hiddenEntryIds: Set<string>;
  messageCount: number;
};

function getPendingFold(): PendingFold | undefined {
  return (globalThis as Record<string, unknown>)[pendingFoldKey] as
    PendingFold | undefined;
}

function setPendingFold(value: PendingFold | undefined): void {
  if (value) (globalThis as Record<string, unknown>)[pendingFoldKey] = value;
  else delete (globalThis as Record<string, unknown>)[pendingFoldKey];
}

function getPendingReloadNotice(): string | undefined {
  const value = (globalThis as Record<string, unknown>)[pendingReloadNoticeKey];
  return typeof value === "string" ? value : undefined;
}

function setPendingReloadNotice(value: string | undefined): void {
  if (value)
    (globalThis as Record<string, unknown>)[pendingReloadNoticeKey] = value;
  else delete (globalThis as Record<string, unknown>)[pendingReloadNoticeKey];
}

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text?: string } => {
      return (
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text"
      );
    })
    .map((part) => part.text ?? "")
    .join("\n");
}

export function label(text: string, index: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const preview = oneLine.length > 100 ? `${oneLine.slice(0, 97)}...` : oneLine;
  return `${index + 1}. ${preview || "(empty message)"}`;
}

function markerData(entry: SessionEntry): FoldMarkerData | undefined {
  if (entry.type !== "custom" || entry.customType !== FOLD_ENTRY)
    return undefined;
  if (!entry.data || typeof entry.data !== "object") return undefined;

  const data = entry.data as Record<string, unknown>;
  if (typeof data.foldId !== "string") return undefined;
  if (data.kind !== "start" && data.kind !== "end") return undefined;

  if (data.kind === "start") {
    if (
      !Array.isArray(data.hiddenEntryIds) ||
      !data.hiddenEntryIds.every((id) => typeof id === "string")
    ) {
      return undefined;
    }
    return {
      kind: "start",
      foldId: data.foldId,
      hiddenEntryIds: data.hiddenEntryIds,
      messageCount:
        typeof data.messageCount === "number" ? data.messageCount : undefined,
      sourceEntryId:
        typeof data.sourceEntryId === "string" ? data.sourceEntryId : undefined,
    };
  }

  return { kind: "end", foldId: data.foldId };
}

/**
 * Read complete folds from an active branch. A start marker without its end
 * marker is ignored so an interrupted append never hides part of a session.
 */
export function activeFolds(entries: readonly SessionEntry[]): FoldRecord[] {
  const starts = new Map<string, { entryId: string; data: FoldMarkerData }>();
  const ends = new Map<string, string>();

  for (const entry of entries) {
    const data = markerData(entry);
    if (!data) continue;
    if (data.kind === "start")
      starts.set(data.foldId, { entryId: entry.id, data });
    else ends.set(data.foldId, entry.id);
  }

  const folds: FoldRecord[] = [];
  for (const [foldId, start] of starts) {
    const endEntryId = ends.get(foldId);
    if (!endEntryId || !start.data.hiddenEntryIds) continue;
    folds.push({
      foldId,
      startEntryId: start.entryId,
      endEntryId,
      hiddenEntryIds: new Set(start.data.hiddenEntryIds),
      messageCount: start.data.messageCount ?? start.data.hiddenEntryIds.length,
    });
  }
  return folds;
}

function isMessageEntry(
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "message" }> {
  return entry.type === "message";
}

/**
 * Apply the UI representation of folds to a compaction-aware entry list.
 *
 * Fold markers are appended at the current leaf because Pi's session format is
 * append-only. This function treats them as virtual separators and moves them
 * back around the referenced entries while removing the referenced entries from
 * the rendered list.
 */
export function foldEntriesForDisplay(
  entries: readonly SessionEntry[],
  folds: readonly FoldRecord[],
): SessionEntry[] {
  if (folds.length === 0) return [...entries];

  const foldMarkerIds = new Set<string>();
  for (const fold of folds) {
    foldMarkerIds.add(fold.startEntryId);
    foldMarkerIds.add(fold.endEntryId);
  }

  const hiddenEntryIds = new Set<string>();
  for (const fold of folds) {
    for (const id of fold.hiddenEntryIds) hiddenEntryIds.add(id);
  }

  const baseEntries = entries.filter((entry) => !foldMarkerIds.has(entry.id));
  const positions = new Map<string, number>();
  for (const [index, entry] of baseEntries.entries())
    positions.set(entry.id, index);

  const entryOrder = new Map<string, number>();
  for (const [index, entry] of entries.entries())
    entryOrder.set(entry.id, index);

  const startsAt = new Map<number, SessionEntry[]>();
  const endsAt = new Map<number, SessionEntry[]>();
  const trailing: Array<{ start: SessionEntry; end: SessionEntry }> = [];

  const addMarker = (
    map: Map<number, SessionEntry[]>,
    position: number,
    entry: SessionEntry,
  ) => {
    const current = map.get(position) ?? [];
    current.push(entry);
    current.sort(
      (a, b) => (entryOrder.get(a.id) ?? 0) - (entryOrder.get(b.id) ?? 0),
    );
    map.set(position, current);
  };

  for (const fold of folds) {
    // A larger fold may contain an earlier fold's markers. Do not resurrect
    // nested separators inside the larger hidden region.
    if (
      hiddenEntryIds.has(fold.startEntryId) ||
      hiddenEntryIds.has(fold.endEntryId)
    )
      continue;

    const start = entries.find((entry) => entry.id === fold.startEntryId);
    const end = entries.find((entry) => entry.id === fold.endEntryId);
    if (!start || !end) continue;

    const visiblePositions = [...fold.hiddenEntryIds]
      .map((id) => positions.get(id))
      .filter((position): position is number => position !== undefined)
      .sort((a, b) => a - b);

    if (visiblePositions.length === 0) {
      // The content may have already been removed by a compaction boundary.
      // Keep a trace of the fold at the end of the visible transcript.
      trailing.push({ start, end });
      continue;
    }

    addMarker(startsAt, visiblePositions[0], start);
    addMarker(endsAt, visiblePositions[visiblePositions.length - 1] + 1, end);
  }

  const result: SessionEntry[] = [];
  for (let position = 0; position <= baseEntries.length; position += 1) {
    // An end belongs before a new fold beginning at the same boundary.
    for (const marker of endsAt.get(position) ?? []) result.push(marker);
    for (const marker of startsAt.get(position) ?? []) result.push(marker);

    const entry = baseEntries[position];
    if (entry && !hiddenEntryIds.has(entry.id)) result.push(entry);
  }

  for (const { start, end } of trailing) {
    result.push(start, end);
  }
  return result;
}

function contextEntriesForManager(manager: any): SessionEntry[] {
  return buildContextEntriesFromEntries(
    manager.getEntries() as SessionEntry[],
    manager.getLeafId(),
  );
}

function messageKey(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? `${typeof value}:${String(value)}`
      : serialized;
  } catch {
    return String(value);
  }
}

/**
 * Remove folded messages from the context event. Context events contain
 * messages rather than entry IDs, so align the freshly reconstructed session
 * messages with the agent's message list before removing by entry ID. The
 * direct-index path handles duplicate messages without collapsing them onto one
 * another; the subsequence path also copes with messages injected by another
 * extension.
 */
export function filterContextMessages<T>(
  messages: readonly T[],
  manager: any,
): T[] {
  const folds = activeFolds(manager.getBranch() as SessionEntry[]);
  if (folds.length === 0) return [...messages];

  const hiddenEntryIds = new Set<string>();
  for (const fold of folds) {
    for (const id of fold.hiddenEntryIds) hiddenEntryIds.add(id);
  }

  const baseMessages: unknown[] = [];
  const hiddenIndexes = new Set<number>();
  for (const entry of contextEntriesForManager(manager)) {
    const converted = sessionEntryToContextMessages(entry);
    const hidden = isMessageEntry(entry) && hiddenEntryIds.has(entry.id);
    for (const message of converted) {
      if (hidden) hiddenIndexes.add(baseMessages.length);
      baseMessages.push(message);
    }
  }
  if (hiddenIndexes.size === 0 || baseMessages.length === 0)
    return [...messages];

  const actualKeys = messages.map(messageKey);
  const baseKeys = baseMessages.map(messageKey);
  const hiddenActualIndexes = new Set<number>();

  const hasDirectAlignment = baseKeys.every(
    (key, index) => actualKeys[index] === key,
  );
  if (hasDirectAlignment) {
    for (const index of hiddenIndexes) hiddenActualIndexes.add(index);
  } else {
    let actualIndex = 0;
    for (const [baseIndex, key] of baseKeys.entries()) {
      while (actualIndex < actualKeys.length && actualKeys[actualIndex] !== key)
        actualIndex += 1;
      if (actualIndex >= actualKeys.length) break;
      if (hiddenIndexes.has(baseIndex)) hiddenActualIndexes.add(actualIndex);
      actualIndex += 1;
    }
  }

  return messages.filter((_message, index) => !hiddenActualIndexes.has(index));
}

/**
 * Install the small session-manager adapter needed by Pi's transcript loader.
 * The public context event can filter provider requests, but the built-in TUI
 * gets its initial transcript directly from buildContextEntries(). Wrapping the
 * two read methods keeps the feature extension-local while allowing the normal
 * custom-entry renderer to place the markers in the transcript.
 */
function installSessionFilters(manager: unknown): void {
  const target = manager as any;
  if (
    !target ||
    typeof target.buildContextEntries !== "function" ||
    typeof target.buildSessionContext !== "function" ||
    target[sessionFilterPatchKey]
  ) {
    return;
  }

  const rawBuildContextEntries = target.buildContextEntries.bind(target);
  const rawBuildSessionContext = target.buildSessionContext.bind(target);

  target.buildContextEntries = () => {
    const entries = rawBuildContextEntries() as SessionEntry[];
    return foldEntriesForDisplay(
      entries,
      activeFolds(target.getBranch() as SessionEntry[]),
    );
  };

  target.buildSessionContext = () => {
    const context = rawBuildSessionContext();
    const entries = rawBuildContextEntries() as SessionEntry[];
    const folds = activeFolds(target.getBranch() as SessionEntry[]);
    const visibleEntries = foldEntriesForDisplay(entries, folds);
    return {
      ...context,
      messages: visibleEntries.flatMap((entry) =>
        sessionEntryToContextMessages(entry),
      ),
    };
  };

  target[sessionFilterPatchKey] = true;
}

async function chooseSource(
  ctx: ExtensionCommandContext,
  branch: SessionEntry[],
): Promise<
  | { source: Extract<SessionEntry, { type: "message" }>; sourceIndex: number }
  | undefined
> {
  const userEntries = branch.filter(
    (entry): entry is Extract<SessionEntry, { type: "message" }> =>
      entry.type === "message" && entry.message.role === "user",
  );
  if (userEntries.length === 0) {
    ctx.ui.notify("There are no user messages to fold from.", "error");
    return undefined;
  }

  const selected = await ctx.ui.select(
    "Fold from which user message?",
    userEntries.map((entry, index) =>
      label(textOf(entry.message.content), index),
    ),
  );
  if (!selected) return undefined;

  const selectedIndex = userEntries.findIndex(
    (_entry, index) =>
      label(textOf(userEntries[index].message.content), index) === selected,
  );
  const source = userEntries[selectedIndex];
  if (!source) return undefined;

  const sourceIndex = branch.findIndex((entry) => entry.id === source.id);
  return sourceIndex < 0 ? undefined : { source, sourceIndex };
}

function latestAssistantIndex(branch: SessionEntry[]): number {
  return (
    [...branch]
      .map((entry, index) => ({ entry, index }))
      .reverse()
      .find(
        ({ entry }) =>
          entry.type === "message" && entry.message.role === "assistant",
      )?.index ?? -1
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer<FoldMarkerData>(
    FOLD_ENTRY,
    (entry, _options, theme) => {
      const data = markerData(entry as SessionEntry);
      if (!data)
        return new Text(
          theme.fg("error", "Invalid sesseract fold marker."),
          1,
          0,
        );

      if (data.kind === "start") {
        const count = data.messageCount ?? data.hiddenEntryIds?.length ?? 0;
        const noun = count === 1 ? "message" : "messages";
        return new Text(
          theme.fg("accent", `┌─ sesseract fold: ${count} ${noun} hidden ─┐`),
          1,
          0,
        );
      }

      return new Text(theme.fg("accent", "└─ end sesseract fold ─┘"), 1, 0);
    },
  );

  pi.on("session_start", async (event, ctx) => {
    installSessionFilters(ctx.sessionManager);

    const notice = getPendingReloadNotice();
    if (notice) {
      setPendingReloadNotice(undefined);
      ctx.ui.notify(notice, "info");
    }

    if (event.reason !== "fork") return;
    const pending = getPendingFold();
    if (!pending) return;

    try {
      const model = ctx.model as any;
      await (ctx.sessionManager as any).appendMessage({
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
      ctx.ui.notify(
        `Could not append folded answer: ${String(error)}`,
        "error",
      );
    }
  });

  pi.on("context", async (event, ctx) => {
    const messages = filterContextMessages(
      event.messages,
      ctx.sessionManager as any,
    );
    return { messages };
  });

  for (const [command, foldAll] of [
    ["fold", false],
    ["fold-all", true],
  ] as const) {
    pi.registerCommand(command, {
      description: foldAll
        ? "Fork from a user message and preserve the complete subsequent turn"
        : "Fork from a user message and preserve the current answer as its content",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();

        const branch = ctx.sessionManager.getBranch() as SessionEntry[];
        const assistantIndex = latestAssistantIndex(branch);
        const latestAssistant =
          assistantIndex >= 0 ? branch[assistantIndex] : undefined;

        if (
          !latestAssistant ||
          latestAssistant.type !== "message" ||
          latestAssistant.message.role !== "assistant"
        ) {
          ctx.ui.notify("There is no assistant answer to fold.", "error");
          return;
        }

        const selection = await chooseSource(ctx, branch);
        if (!selection) return;
        const { source, sourceIndex } = selection;

        const answer = textOf(latestAssistant.message.content);
        if (!answer) {
          ctx.ui.notify(
            "The latest assistant answer has no text content.",
            "error",
          );
          return;
        }

        const prefix = branch
          .slice(0, sourceIndex + 1)
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.message as any);
        const parentSession = ctx.sessionManager.getSessionFile();
        const currentModel = ctx.model as any;
        const assistantMetadata = {
          api: currentModel?.api ?? "unknown",
          provider: currentModel?.provider ?? "unknown",
          model: currentModel?.id ?? currentModel?.model ?? "unknown",
        };
        const foldedMessages = foldAll
          ? branch
              .slice(sourceIndex + 1)
              .filter((entry) => entry.type === "message")
              .map((entry) => entry.message as any)
          : [
              {
                role: "assistant",
                content: [{ type: "text", text: answer }],
                ...assistantMetadata,
                usage: zeroUsage,
                stopReason: "stop",
                timestamp: Date.now(),
              },
            ];

        const result = await ctx.newSession({
          parentSession,
          setup: async (sm) => {
            for (const message of prefix) await sm.appendMessage(message);
            for (const message of foldedMessages) {
              await sm.appendMessage({
                ...message,
                ...(message.role === "assistant" ? assistantMetadata : {}),
                timestamp: Date.now(),
              } as any);
            }
          },
          withSession: async (replacementCtx) =>
            replacementCtx.ui.notify("Folded into a new session.", "info"),
        });

        if (result.cancelled) ctx.ui.notify("Fold cancelled.", "info");
      },
    });
  }

  pi.registerCommand("fold-in-place", {
    description:
      "Hide the messages after a user message in this session and keep the current answer",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const branch = ctx.sessionManager.getBranch() as SessionEntry[];
      const assistantIndex = latestAssistantIndex(branch);
      if (assistantIndex < 0) {
        ctx.ui.notify("There is no assistant answer to fold.", "error");
        return;
      }

      const selection = await chooseSource(ctx, branch);
      if (!selection) return;
      const { source, sourceIndex } = selection;
      if (assistantIndex <= sourceIndex) {
        ctx.ui.notify(
          "The selected user message has no later assistant answer.",
          "error",
        );
        return;
      }

      // Keep the selected user message and the latest answer visible, matching
      // /fold's replacement-session behavior. Everything between them remains
      // in the same session but is represented by the two fold markers.
      const hiddenEntries = branch.slice(sourceIndex + 1, assistantIndex);
      const hiddenEntryIds = hiddenEntries.map((entry) => entry.id);
      const messageCount = hiddenEntries.filter(isMessageEntry).length;
      if (messageCount === 0) {
        ctx.ui.notify(
          "There are no messages between the selected request and the current answer.",
          "error",
        );
        return;
      }

      const foldId = randomUUID();
      pi.appendEntry<FoldMarkerData>(FOLD_ENTRY, {
        kind: "start",
        foldId,
        hiddenEntryIds,
        messageCount,
        sourceEntryId: source.id,
      });
      pi.appendEntry<FoldMarkerData>(FOLD_ENTRY, { kind: "end", foldId });

      const notice = `Folded ${messageCount} message${messageCount === 1 ? "" : "s"} in place.`;
      if (ctx.mode === "tui") {
        // Pi's public extension UI has no transcript-rebuild method. Reloading
        // is the supported way to make the built-in chat reconstruct itself;
        // the session-manager adapter above makes that reconstruction fold-aware.
        setPendingReloadNotice(notice);
        try {
          await ctx.reload();
        } catch (error) {
          setPendingReloadNotice(undefined);
          ctx.ui.notify(
            `Could not refresh the folded transcript: ${String(error)}`,
            "error",
          );
        }
        return;
      }

      ctx.ui.notify(notice, "info");
    },
  });
}
