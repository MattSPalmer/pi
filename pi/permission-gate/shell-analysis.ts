import { execFileSync } from "node:child_process";

export type ShellAnalysis =
  | {
      safe: true;
      tokens: string[];
      paths: string[];
      commands: string[];
      commandArgv: string[][];
      heads: string[];
      redirects: string[];
    }
  | { safe: false; reason: string };

export const opaqueShellCommands = new Set([
  "bash",
  "dash",
  "eval",
  "exec",
  "env",
  "fish",
  "node",
  "osascript",
  "perl",
  "python",
  "python3",
  "ruby",
  "sh",
  "xargs",
  "zsh",
]);

const pathBearingCommands = new Set([
  "cat",
  "cmp",
  "cp",
  "diff",
  "du",
  "file",
  "head",
  "less",
  "ln",
  "ls",
  "mkdir",
  "mv",
  "open",
  "readlink",
  "realpath",
  "rm",
  "rmdir",
  "stat",
  "tail",
  "touch",
  "wc",
]);
export const looksLikePath = (value: string): boolean =>
  /^(?:~(?:\/|$)|\/(?:\/|$)|\.\.?(?:\/|$))/.test(value) || value.includes("/");

const pathLike = looksLikePath;
const unique = (values: string[]) => [...new Set(values)];
export const defaultRustAnalyzer = "tree-sitter-bash-analyzer";
export const rustAnalyzer = (): string =>
  process.env.PI_PERMISSION_ANALYZER || defaultRustAnalyzer;

export const analyzeWithRust = (command: string): ShellAnalysis => {
  try {
    const raw = execFileSync(rustAnalyzer(), [command], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(raw) as {
      status: string;
      reason?: string;
      commands?: { argv: string[]; redirects?: string[] }[];
    };
    if (result.status !== "ok" || !result.commands?.length)
      return { safe: false, reason: result.reason || "opaque shell syntax" };
    if (
      result.commands.some(
        (entry) =>
          !Array.isArray(entry.argv) ||
          !entry.argv.length ||
          entry.argv.some((value) => typeof value !== "string"),
      )
    )
      return {
        safe: false,
        reason: "analyzer returned a malformed command list",
      };
    if (
      result.commands.some(({ argv }) => {
        const head = argv[0].split("/").pop() || argv[0];
        return (
          head === "fd" &&
          argv
            .slice(1)
            .some(
              (value) =>
                value === "-x" ||
                value === "-X" ||
                value === "--exec" ||
                value === "--exec-batch" ||
                value.startsWith("-x=") ||
                value.startsWith("-X=") ||
                value.startsWith("--exec=") ||
                value.startsWith("--exec-batch="),
            )
        );
      })
    )
      return { safe: false, reason: "fd execution option requires approval" };
    return {
      safe: true,
      tokens: result.commands.flatMap((entry) => entry.argv),
      paths: unique(
        result.commands.flatMap((entry) =>
          entry.argv.slice(1).filter((value) => !value.startsWith("-")),
        ),
      ),
      commands: result.commands.map((entry) => entry.argv.join(" ")),
      commandArgv: result.commands.map((entry) => entry.argv),
      heads: unique(
        result.commands.map(
          (entry) => entry.argv[0].split("/").pop() || entry.argv[0],
        ),
      ),
      redirects: unique(
        result.commands.flatMap((entry) => entry.redirects ?? []),
      ),
    };
  } catch (error) {
    return {
      safe: false,
      reason: `Rust shell analyzer unavailable or failed: ${String(error)}`,
    };
  }
};

export const tokenizeSimpleShell = (command: string): ShellAnalysis => {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else token += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "$" || char === "`")
        return { safe: false, reason: "shell expansion is opaque" };
      else token += char;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    if (/[;&|<>`()\n$]/.test(char))
      return { safe: false, reason: "shell control syntax is opaque" };
    token += char;
  }
  if (quote || escaped)
    return { safe: false, reason: "unterminated shell quoting or escape" };
  if (token) tokens.push(token);
  if (!tokens.length) return { safe: false, reason: "empty shell command" };
  const commandName = tokens[0].split("/").pop() || tokens[0];
  if (opaqueShellCommands.has(commandName))
    return { safe: false, reason: `${commandName} can execute opaque code` };
  if (
    tokens.some((token) =>
      ["-exec", "-execdir", "-delete", "-ok", "-okdir"].includes(token),
    )
  )
    return {
      safe: false,
      reason: "filesystem command contains an opaque execution option",
    };
  if (
    commandName === "fd" &&
    tokens
      .slice(1)
      .some(
        (token) =>
          token === "-x" ||
          token === "-X" ||
          token === "--exec" ||
          token === "--exec-batch" ||
          token.startsWith("-x=") ||
          token.startsWith("-X=") ||
          token.startsWith("--exec=") ||
          token.startsWith("--exec-batch="),
      )
  )
    return { safe: false, reason: "fd execution option requires approval" };
  const args = tokens.slice(1).filter((token) => !token.startsWith("-"));
  let paths = args.filter(pathLike);
  if (pathBearingCommands.has(commandName)) paths = args;
  if (commandName === "grep" || commandName === "rg") paths = args.slice(1);
  if (commandName === "find") paths = args.slice(0, 1);
  if (commandName === "fd") paths = args.slice(1);
  return {
    safe: true,
    tokens,
    paths: unique(paths),
    commands: [tokens.join(" ")],
    commandArgv: [tokens],
    heads: [commandName],
    redirects: [],
  };
};
