/** Keep Pi's theme synchronized with the macOS system appearance. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 2_000;

/** macOS omits AppleInterfaceStyle when the system is in light mode. */
async function systemTheme(): Promise<"dark" | "light" | undefined> {
  if (process.platform !== "darwin") return undefined;

  try {
    const { stdout } = await execFileAsync("defaults", [
      "read",
      "-g",
      "AppleInterfaceStyle",
    ]);
    return stdout.trim().toLowerCase() === "dark" ? "dark" : "light";
  } catch {
    // A missing preference is the normal representation of light mode.
    return "light";
  }
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeTheme: "dark" | "light" | undefined;

  // Never retain a context in the polling callback. Session replacement makes
  // previously captured contexts stale (fork, switch, reload, and newSession).
  // Polling only records the latest theme; a current event context applies it.
  let pendingTheme: "dark" | "light" | undefined;
  const apply = async (ctx: any) => {
    const nextTheme = pendingTheme ?? (await systemTheme());
    if (!nextTheme || nextTheme === activeTheme) return;
    activeTheme = nextTheme;
    if (ctx.hasUI) ctx.ui.setTheme(nextTheme);
  };

  pi.on("session_start", async (_event, ctx) => {
    // The new session may have a new UI even if the system theme is unchanged.
    activeTheme = undefined;
    pendingTheme = await systemTheme();
    await apply(ctx);
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      void systemTheme().then((theme) => {
        pendingTheme = theme;
      });
    }, POLL_INTERVAL_MS);
    timer.unref?.();
  });

  // These contexts are fresh even after a session replacement.
  for (const event of ["turn_start", "agent_start"] as const) {
    pi.on(event, async (_event, ctx) => apply(ctx));
  }

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    activeTheme = undefined;
  });
}
