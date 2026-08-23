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

  pi.on("session_start", async (_event, ctx) => {
    const apply = async () => {
      const nextTheme = await systemTheme();
      if (!nextTheme || nextTheme === activeTheme) return;
      activeTheme = nextTheme;
      if (ctx.hasUI) ctx.ui.setTheme(nextTheme);
    };

    await apply();
    timer = setInterval(() => void apply(), POLL_INTERVAL_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    activeTheme = undefined;
  });
}
