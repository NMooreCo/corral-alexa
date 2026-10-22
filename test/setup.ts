import { Temporal } from "temporal-polyfill";
import { openMeteo } from "./ranch-fixtures.ts";

// No test waits on the network for a forecast: a request to Open-Meteo gets a recorded forecast that starts on the
// test clock's date in the time zone the request names, and every other fetch goes out as it would. A test that
// stubs fetch itself, or hands the weather its own fetch, still gets its own.
const real = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== "https://api.open-meteo.com") return real(input, init);
  const zone = url.searchParams.get("timezone") ?? "UTC";
  const start = Temporal.Instant.fromEpochMilliseconds(Date.now()).toZonedDateTimeISO(zone).toPlainDate().toString();
  return Response.json(openMeteo(start));
}) as typeof fetch;
