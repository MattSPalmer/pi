import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type AuditState = {
  prompted: boolean;
  promptCount: number;
  decision?: "allowed" | "denied";
  rule?: string;
  reason?: string;
  statements?: string[];
  scope?: string;
  duration?: "session" | "once";
};

export const auditStates = new WeakMap<object, AuditState>();

export const markPrompt = (
  ctx: any,
  rule: string,
  decision?: "allowed" | "denied",
  reason?: string,
  fields: Partial<AuditState> = {},
) => {
  const state = auditStates.get(ctx);
  if (!state) return;
  state.prompted = true;
  state.promptCount += 1;
  state.rule = rule;
  state.decision = decision;
  state.reason = reason;
  Object.assign(state, fields);
};

const permissionLog =
  process.env.PI_PERMISSION_LOG ||
  join(process.env.HOME || "~", ".pi", "permission-requests.jsonl");

export const recordPermissionRequest = (
  ctx: any,
  fields: Record<string, unknown>,
) => {
  try {
    mkdirSync(dirname(permissionLog), { recursive: true });
    appendFileSync(
      permissionLog,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        session: process.env.PI_SESSION_ID || `pid-${process.pid}`,
        subagent: process.env.PI_SUBAGENT_NAME || null,
        cwd: ctx.cwd,
        ...fields,
      }) + "\n",
    );
  } catch (_) {
    // Auditing must never affect permission decisions.
  }
};
