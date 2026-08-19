import { markPrompt } from "./audit";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[39m";

export type StatementAnnotation = {
  statement: string;
  problems?: string[];
};

/** Keep the command readable, while making the reason for review visible. */
export const annotateStatements = (entries: StatementAnnotation[]): string =>
  entries.map(({ statement, problems }) => {
    const note = problems?.length
      ? ` ${YELLOW}(${problems.join(", ")})${RESET}`
      : ` ${YELLOW}(no problems detected)${RESET}`;
    return `  - ${statement}${note}`;
  }).join("\\n");

/** Present a compound command as one bullet per parsed statement. */
export const askBash = async (
  ctx: any,
  label: string,
  command: string,
  tool = "bash",
  statements?: string[],
  annotations?: StatementAnnotation[],
) => {
  const parts = (statements ?? []).filter((s) => s.trim().length);
  const display = parts.length > 1
    ? annotateStatements(annotations ?? parts.map((statement) => ({ statement })))
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
