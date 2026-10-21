// Runs the open Alexa+ simulator against this bridge: Corral on a simulated
// Echo Show or Echo Dot, or the readiness check against Alexa+'s published
// requirements.
//
//   pnpm simulate                      the local bridge (pnpm dev, port 8795) on a simulated Echo
//   pnpm simulate check                the readiness check against the local bridge
//   pnpm simulate check <mcp-url>      the check against a deployment, like https://alexa.corral.narralogy.ai/mcp
//   pnpm simulate <mcp-url> [options]  any other options go to the simulator (--help for them)
//
// Talking uses the same model credentials as the bridge's own Echo page
// (ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL, from the environment or .dev.vars).
// Until the simulator is published, it runs from its checkout beside this one
// (../alexa-plus-simulator, built with `pnpm build`), or wherever ALEXA_SIMULATOR points.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOCAL = "http://127.0.0.1:8795/mcp";
const cli = process.env.ALEXA_SIMULATOR ?? fileURLToPath(new URL("../../alexa-plus-simulator/dist/server/cli.js", import.meta.url));
if (!existsSync(cli)) {
  console.error(`The Alexa+ simulator isn't at ${cli}.`);
  console.error("Build it in its checkout (pnpm install && pnpm build), or set ALEXA_SIMULATOR to its dist/server/cli.js.");
  process.exit(1);
}

/** The model's credentials from .dev.vars, for what the environment doesn't already set. */
function devVars() {
  const file = new URL("../.dev.vars", import.meta.url);
  if (!existsSync(file)) return {};
  const vars = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) vars[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return vars;
}

const args = process.argv.slice(2);
const sub = args[0] === "check" ? args.shift() : null;
// The first argument is the server unless it's an option.
const target = args[0] && !args[0].startsWith("-") ? args.shift() : LOCAL;
// Someone at a terminal gets the page opened for them.
const run = sub ? [sub, target, ...args] : [target, ...(process.stdout.isTTY ? ["--open"] : []), ...args];

const child = spawn(process.execPath, [cli, ...run], { stdio: "inherit", env: { ...process.env, ...devVars() } });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
// Ctrl+C reaches the simulator too; it stops itself and exits.
process.on("SIGINT", () => {});
