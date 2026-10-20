import { AwsClient } from "aws4fetch";
import type { Env } from "../env.ts";
import { json } from "../http.ts";
import { demoGate } from "./gate.ts";

/**
 * The simulated Echo Show's voice: Amazon Polly says each answer, so the
 * device sounds the same in every browser. Requests are signed with an IAM
 * key that may only call polly:SynthesizeSpeech. The page uses the browser's
 * own speech when this isn't set up or doesn't answer.
 */

const MAX_TEXT = 1000;

export function voiceReady(env: Env): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

export async function voiceTurn(request: Request, env: Env): Promise<Response> {
  if (!voiceReady(env)) return json(503, { error: { code: "not_configured", message: "The simulator's voice isn't set up on this server." } });
  const stopped = await demoGate(request, env, env.VOICE_LIMIT);
  if (stopped) return stopped;
  const body = (await request.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT) return json(400, { error: { code: "bad_request", message: `Send text of 1 to ${MAX_TEXT} characters.` } });

  const region = env.POLLY_REGION ?? "us-west-2";
  const voice = env.POLLY_VOICE ?? "Joanna";
  const engine = env.POLLY_ENGINE ?? "generative";
  const aws = new AwsClient({ accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY!, service: "polly", region });
  const res = await aws.fetch(`https://polly.${region}.amazonaws.com/v1/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ Engine: engine, OutputFormat: "mp3", Text: text, TextType: "text", VoiceId: voice }),
  });
  if (!res.ok) {
    // Polly's own words stay in the Worker's log; the page falls back to the browser's voice.
    console.error(`Polly answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return json(502, { error: { code: "voice_error", message: `Polly answered ${res.status}.` } });
  }
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-voice": `${voice}, ${engine}` } });
}
