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
// The simulator comes from its npm package (alexa-plus-simulator, a dev dependency), or from wherever
// ALEXA_SIMULATOR points, like a checkout's dist/server/cli.js.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const LOCAL = "http://127.0.0.1:8795/mcp";
// The package's exports name only its library, so its CLI is found beside its package.json.
const cli = process.env.ALEXA_SIMULATOR ?? join(dirname(createRequire(import.meta.url).resolve("alexa-plus-simulator/package.json")), "dist", "server", "cli.js");
if (!existsSync(cli)) {
  console.error(`The Alexa+ simulator isn't at ${cli}.`);
  console.error("Run pnpm install, or set ALEXA_SIMULATOR to a checkout's dist/server/cli.js.");
  process.exit(1);
}

/** The model's credentials from .dev.vars when the environment has no key of its own: the key and its base URL go together. */
function devVars() {
  const file = new URL("../.dev.vars", import.meta.url);
  if (process.env.ANTHROPIC_API_KEY || !existsSync(file)) return {};
  const vars = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
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
