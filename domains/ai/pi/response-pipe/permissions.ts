import { normalize } from "node:path";
import {
  evaluateAllowlist,
  loadPolicyRules,
  sessionGrantsFromEntries,
  type AllowlistVerdict,
} from "../permission-gate/evaluate.ts";

export interface PipePermissionOptions {
  command: string;
  cwd: string;
  sessionEntries: Iterable<unknown>;
  home?: string;
}

/**
 * Adapt the portable policy evaluator to response-pipe. Pi's startup
 * directory is trusted by permission-gate; response-pipe treats its current
 * working directory the same way. Session grants are read from persisted
 * entries instead of relying on extension load order or shared module state.
 */
export function evaluatePipePermissions(
  options: PipePermissionOptions,
): AllowlistVerdict {
  const cwd = normalize(options.cwd);
  const grants = sessionGrantsFromEntries(options.sessionEntries);
  grants.paths.unshift(cwd);
  return evaluateAllowlist({
    command: options.command,
    cwd,
    rules: loadPolicyRules(cwd, options.home),
    grants,
  });
}
