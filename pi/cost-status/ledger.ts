/** Cross-process cost ledger for recursively aggregated Pi subagent costs. */

export const LEDGER_ENV = "PI_COST_LEDGER";

export interface CostRecord {
  id: string;
  agent: string;
  cost: number;
  turns: number;
}

export function parseLedger(text: string): CostRecord[] {
  const byId = new Map<string, CostRecord>();
  for (const line of text.split("\n")) {
    try {
      const value = JSON.parse(line) as Partial<CostRecord>;
      if (typeof value.id !== "string" || !value.id || typeof value.cost !== "number" || !Number.isFinite(value.cost)) continue;
      byId.set(value.id, {
        id: value.id,
        agent: typeof value.agent === "string" && value.agent ? value.agent : "subagent",
        cost: value.cost,
        turns: typeof value.turns === "number" && Number.isFinite(value.turns) ? value.turns : 0,
      });
    } catch { /* Ignore incomplete or malformed concurrent writes. */ }
  }
  return [...byId.values()];
}

export function serializeRecord(record: CostRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function sumAssistantCost(entries: Iterable<unknown>): number {
  let total = 0;
  for (const entry of entries) {
    const value = entry as { type?: string; message?: { role?: string; usage?: { cost?: { total?: number } } } };
    const cost = value?.message?.usage?.cost?.total;
    if (value?.type === "message" && value.message?.role === "assistant" && typeof cost === "number" && Number.isFinite(cost)) total += cost;
  }
  return total;
}

export function formatCost(value: number): string {
  return `$${(Number.isFinite(value) ? value : 0).toFixed(4)}`;
}

export function formatCostStatus(sessionCost: number, descendants: CostRecord[]): string {
  const descendantCost = descendants.reduce((sum, record) => sum + record.cost, 0);
  const total = sessionCost + descendantCost;
  const count = descendants.length;
  return `${formatCost(sessionCost)} session · ${formatCost(total)} total${count ? ` (+${count} agent${count === 1 ? "" : "s"})` : ""}`;
}
