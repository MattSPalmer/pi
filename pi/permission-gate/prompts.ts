import { markPrompt } from "./audit";

/** Present a compound command as one bullet per parsed statement. */
export const askBash = async (
  ctx: any,
  label: string,
  command: string,
  tool = "bash",
  statements?: string[],
) => {
  const parts = (statements ?? []).filter((s) => s.trim().length);
  const display = parts.length > 1
    ? parts.map((s) => `  - ${s}`).join("\n")
    : `  ${command}`;
  if (!ctx.hasUI) {
    markPrompt(ctx, label, "denied", "no-ui", {
      statements: parts.length > 1 ? parts : undefined,
    });
    return { block: true, reason: `Needs approval (${label}), no UI available` };
  }
  const choice = await ctx.ui.select(
    `Permission rule ${label} requires approval:\n\n${display}\n\nAllow?`,
    ["Yes", "No"],
  );
  markPrompt(ctx, label, choice === "Yes" ? "allowed" : "denied", undefined, {
    statements: parts.length > 1 ? parts : undefined,
  });
  return choice === "Yes" ? undefined : { block: true, reason: "Blocked by user" };
};
