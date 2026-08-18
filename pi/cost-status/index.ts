import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LEDGER_ENV, formatCostStatus, parseLedger, serializeRecord, sumAssistantCost, type CostRecord } from "./ledger.ts";

const STATUS_KEY = "session-cost";
const POLL_MS = 1000;

export default function (pi: ExtensionAPI) {
  const inheritedLedger = process.env[LEDGER_ENV];
  const isRoot = !inheritedLedger;
  const ledgerPath = inheritedLedger ?? path.join(os.tmpdir(), `pi-cost-${process.pid}-${Date.now().toString(36)}.jsonl`);
  process.env[LEDGER_ENV] = ledgerPath;

  if (!isRoot) {
    const record: CostRecord = { id: `${process.pid}-${Date.now().toString(36)}`, agent: process.env.PI_SUBAGENT_NAME ?? "subagent", cost: 0, turns: 0 };
    pi.on("message_end", async (event: any) => {
      const cost = event?.message?.usage?.cost?.total;
      if (event?.message?.role !== "assistant" || typeof cost !== "number" || !Number.isFinite(cost)) return;
      record.cost += cost;
      record.turns++;
      try { fs.appendFileSync(ledgerPath, serializeRecord(record)); } catch { /* best effort */ }
    });
    return;
  }

  let lastText = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  const render = (ctx: any) => {
    if (!ctx?.hasUI) return;
    let descendants: CostRecord[] = [];
    try { descendants = parseLedger(fs.readFileSync(ledgerPath, "utf8")); } catch { /* no descendants yet */ }
    const text = formatCostStatus(sumAssistantCost(ctx.sessionManager.getBranch()), descendants);
    if (text !== lastText) {
      lastText = text;
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    render(ctx);
    timer = setInterval(() => render(ctx), POLL_MS);
    timer.unref?.();
  });
  for (const event of ["message_end", "turn_end", "agent_end", "session_compact"] as const) pi.on(event, async (_event, ctx) => render(ctx));
  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    try { fs.unlinkSync(ledgerPath); } catch { /* ignore */ }
  });
}
