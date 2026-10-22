import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The OAuth provider imports the Workers runtime module; Node gets a stand-in.
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)) },
  },
  test: {
    // Bundled through Vite, so the alias above reaches inside it.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
    // The ranch's forecast comes from a recording, never the network.
    setupFiles: ["./test/setup.ts"],
  },
});
