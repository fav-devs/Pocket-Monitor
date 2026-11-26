// Builds the Expo web export of Apps/Mobile and copies it into crates/pm-desktop/ui, the
// folder tauri.conf.json serves as `frontendDist`. The same bundle runs in a browser (demo
// camera) and inside Tauri (DesktopCameraSession): the session is picked at runtime from
// `window.__TAURI_INTERNALS__`, so nothing desktop-specific is baked in.
//
//   node scripts/prepare-ui.mjs            export, then copy
//   node scripts/prepare-ui.mjs --no-export  copy an existing export (PM_WEB_EXPORT or the default dir)
//
// Paths are resolved from this file, so the working directory does not matter.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const crateDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(crateDir, "../../../..");
const mobileDir = path.join(repoRoot, "Apps/Mobile");
const exportDir = process.env.PM_WEB_EXPORT
  ? path.resolve(process.env.PM_WEB_EXPORT)
  : path.join(crateDir, ".web-export");
const uiDir = path.join(crateDir, "ui");

if (!process.argv.includes("--no-export")) {
  if (!existsSync(path.join(mobileDir, "node_modules"))) {
    throw new Error(`No node_modules in ${mobileDir}. Run \`npm ci\` there first.`);
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  console.log(`[prepare-ui] expo export --platform web → ${exportDir}`);
  execFileSync(npx, ["expo", "export", "--platform", "web", "--output-dir", exportDir], {
    cwd: mobileDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, CI: "1" },
  });
}

if (!existsSync(path.join(exportDir, "index.html"))) {
  throw new Error(`No web export at ${exportDir} (index.html missing).`);
}

await rm(uiDir, { recursive: true, force: true });
// Source maps are not needed in the app.
await cp(exportDir, uiDir, { recursive: true, filter: (source) => !source.endsWith(".map") });

let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      files += 1;
      bytes += statSync(full).size;
    }
  }
})(uiDir);
console.log(`[prepare-ui] ${path.relative(repoRoot, uiDir)}: ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);
