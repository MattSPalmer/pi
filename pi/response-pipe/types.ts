export type FailureKind =
  | "exit"
  | "signal"
  | "timeout"
  | "cancelled"
  | "output_limit"
  | "spawn"
  | "denied";

/** Diagnostics passed to the command generator after an execution failure. */
export interface FailureInfo {
  kind: FailureKind;
  command: string;
  exitCode?: number;
  signal?: string;
  stderr: string;
  stderrTruncated?: boolean;
  outputLimit?: "stdout" | "stderr";
  errorMessage?: string;
}

export interface PipeResponseEntry {
  type: "pipe_response";
  request: string;
  command: string;
  inputResponseId?: string;
  output: string;
  exitCode: 0;
  timestamp: string;
}

export const PIPE_RESPONSE_ENTRY = "pipe_response" as const;
