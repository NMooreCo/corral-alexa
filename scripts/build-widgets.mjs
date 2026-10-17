// Builds each screen in widgets/ (and the preview host in preview/) into one
// self-contained HTML file, since an MCP Apps resource can't load anything
// else, and writes them into src/widgets.generated.ts for the worker to serve.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function page(dir, outName) {
  const outDir = path.join(root, "dist", outName);
  await build({
    root: path.join(root, dir),
    configFile: false,
    logLevel: "warn",
    plugins: [viteSingleFile()],
    build: { outDir, emptyOutDir: true, target: "es2022" },
  });
  return readFile(path.join(outDir, "index.html"), "utf8");
}

const names = (await readdir(path.join(root, "widgets"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const widgets = {};
for (const name of names) widgets[name] = await page(path.join("widgets", name), path.join("widgets", name));
const preview = await page("preview", "preview");
// The household Agent Skill, which the server also offers as an MCP prompt.
const skill = await readFile(path.join(root, "skills", "corral-household", "SKILL.md"), "utf8");
const skillTools = await readFile(path.join(root, "skills", "corral-household", "references", "tools.md"), "utf8");

const out = [
  "// Made by scripts/build-widgets.mjs from widgets/, preview/ and skills/. Don't edit it; run pnpm build:widgets.",
  `export const widgetHtml = ${JSON.stringify(widgets, null, 2)} as const;`,
  `export const previewHtml: string = ${JSON.stringify(preview)};`,
  `export const householdSkill: string = ${JSON.stringify(skill)};`,
  `export const householdSkillTools: string = ${JSON.stringify(skillTools)};`,
  "",
].join("\n");
await writeFile(path.join(root, "src", "widgets.generated.ts"), out);
console.log(`Built ${names.length} widget${names.length === 1 ? "" : "s"} (${names.join(", ")}) and the preview`);
