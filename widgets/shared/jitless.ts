import { config } from "zod";

// Zod checks whether it may compile with `new Function` the moment its first object schema is made, and a screen's
// content security policy blocks that (and a host reports it). Jitless skips the check. screen.ts imports this
// module first, so it runs before the MCP Apps library makes its schemas.
config({ jitless: true });
