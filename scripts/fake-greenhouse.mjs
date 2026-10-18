// A stand-in for the ESP32 greenhouse valve controller (firmware v0.1) on this
// machine, for trying the local greenhouse connector without the hardware:
//
//   pnpm greenhouse:fake [port] [key]        (default 8899 and "fake-key")
//   pnpm dev:lan --var GREENHOUSE_URL:http://127.0.0.1:8899 --var GREENHOUSE_KEY:fake-key
//
// It answers the firmware's routes with the firmware's JSON: GET /status,
// POST /on?sec=N (default 300, clamped to 1800, 0 or less is a 400) and
// POST /off, the switching ones only with the right X-Api-Key, and it closes
// the valve when a run ends. It prints each call so a demo can show the valve
// opening, but never prints the key.
import http from "node:http";

const port = Number(process.argv[2] ?? 8899);
const key = process.argv[3] ?? "fake-key";
const MAX_RUN_S = 1800;
const boot = Date.now();
let valveOn = false;
let offAt = 0;

function status() {
  if (valveOn && Date.now() >= offAt) {
    valveOn = false;
    console.log(`${new Date().toLocaleTimeString()}  valve CLOSED (run ended)`);
  }
  return {
    valve: valveOn ? "on" : "off",
    remaining_s: valveOn ? Math.ceil((offAt - Date.now()) / 1000) : 0,
    uptime_s: Math.floor((Date.now() - boot) / 1000),
    rssi: -58,
    climate: { temp_c: 18.4, humidity: valveOn ? 78.5 : 41.2, pressure_hpa: 852.5, age_s: 2, ok: true },
    soil: { age_s: 4, beds: ["s1", "s2", "s3", "s4", "s5"].map((id, i) => ({ id, mv: [1720, 1910, 2440, 1580, 2010][i] })) },
  };
}

setInterval(status, 250);

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://controller");
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
      console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${url.pathname}${url.search}  ${code}${valveOn ? `  valve OPEN, ${Math.ceil((offAt - Date.now()) / 1000)} s left` : ""}`);
    };
    if (req.method === "GET" && url.pathname === "/status") return send(200, status());
    if (req.method === "POST" && (url.pathname === "/on" || url.pathname === "/off")) {
      if (req.headers["x-api-key"] !== key) return send(401, { error: "unauthorized" });
      if (url.pathname === "/off") {
        valveOn = false;
        return send(200, status());
      }
      let sec = 300;
      if (url.searchParams.has("sec")) {
        const n = Number.parseInt(url.searchParams.get("sec") ?? "", 10) || 0;
        if (n <= 0) return send(400, { error: "sec must be a positive integer" });
        sec = Math.min(n, MAX_RUN_S);
      }
      valveOn = true;
      offAt = Date.now() + sec * 1000;
      return send(200, status());
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Content-Type, X-Api-Key" });
      return res.end();
    }
    send(404, { error: "not found" });
  })
  .listen(port, "127.0.0.1", () => console.log(`Fake greenhouse controller at http://127.0.0.1:${port} (firmware v0.1 routes)`));
