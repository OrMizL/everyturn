// Headless Chrome screenshot of local HTML. Usage: screenshot.mjs in.html out.png [width] [height]
// Background networking is disabled; a fresh --user-data-dir hangs on first-run init in this box, so the default headless profile is used.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
const [inp, out, w = "1200", h = "900"] = process.argv.slice(2);
if (!inp || !out) { console.error("usage: screenshot.mjs in.html out.png [w] [h]"); process.exit(2); }
const chrome = process.env.CHROME_BIN || "google-chrome";
try {
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-background-networking", "--disable-component-update", "--no-first-run", "--hide-scrollbars", "--force-device-scale-factor=2",
    `--window-size=${w},${h}`, `--screenshot=${resolve(out)}`, `file://${resolve(inp)}`],
    { stdio: "ignore", timeout: 60_000, killSignal: "SIGKILL" });
  chmodSync(out, 0o600);
  console.log(`wrote ${basename(out)}`);
} catch {
  console.error("Screenshot failed: Chrome unavailable, timed out, or restricted by the sandbox");
  process.exitCode = 1;
} finally {
  if (existsSync(out)) chmodSync(out, 0o600);
}
