import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Whether git leaves this path out, by the repository's own .gitignore. */
function ignored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", path], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("the repository", () => {
  it("keeps every variant of .dev.vars and .env, and the readiness check's screenshots, out of git", () => {
    for (const path of [".dev.vars", ".dev.vars.demo", ".env", ".env.local", ".env.production", "readiness-screenshots/check.png"]) expect(ignored(path), path).toBe(true);
    for (const path of ["src/index.ts", "wrangler.jsonc", "README.md", "docs/devlog/ranch.md"]) expect(ignored(path), path).toBe(false);
  });

  it("checks the live demo when the workflow's comment says, on either side of the end of daylight saving time", () => {
    const workflow = readFileSync(new URL("../.github/workflows/demo-health.yml", import.meta.url), "utf8");
    const comment = /schedule:\s*# (.+)/.exec(workflow)?.[1] ?? "";
    const hours = [...workflow.matchAll(/- cron: "0 (\d+) \* \* \*"/g)].map((m) => Number(m[1]));
    // Mountain Time's hour for each run, on a day each side of November 1, 2026.
    const local = (day: string) => hours.map((h) => Temporal.Instant.from(`${day}T${String(h).padStart(2, "0")}:00:00Z`).toZonedDateTimeISO("America/Denver").hour).sort((a, b) => a - b);
    expect(local("2026-10-25")).toEqual([8, 20]);
    expect(local("2026-11-10")).toEqual([7, 19]);
    expect(comment).toBe("8 AM and 8 PM Mountain Time while it's UTC-6, through November 1; 7 AM and 7 PM after, at UTC-7.");
  });
});
