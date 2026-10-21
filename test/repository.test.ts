import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
});
