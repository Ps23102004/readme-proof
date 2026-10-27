import { parseRepo } from "@/lib/pipeline";
import { census, round } from "@/lib/stages";
import { sign, verify } from "@/lib/token";
import type { Ev } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_ROUNDS = 4;
// Abuse guard for a public demo that spends model credits and sandbox time: every request (census or round) counts.
let day = "", used = 0;
const DAILY_CAP = Number(process.env.LIVE_DAILY_CAP ?? 120);

// NDJSON stream; the last line is {"type":"state","token":...,"next":n} when the client should call the next round.
// The run state travels as an HMAC-signed token bound to the round number, so a client cannot forge prompts or skip rounds.
export async function POST(req: Request) {
  if (process.env.LIVE_ENABLED === "false") return new Response("Live runs are disabled on this deployment; try a recorded run.", { status: 503 });
  const body = await req.json().catch(() => ({}));
  const n = body.round ?? 0;
  if (!Number.isInteger(n) || n < 0 || n > MAX_ROUNDS) return new Response("bad round", { status: 400 });

  const repo = n === 0 ? parseRepo(String(body.repo ?? "")) : null;
  if (n === 0 && !repo) return new Response("Enter a GitHub URL like https://github.com/owner/name", { status: 400 });
  let state = null;
  try { state = n > 0 ? verify(body.token, n) : null; } catch { return new Response("Live runs are not configured on this deployment.", { status: 503 }); }
  if (n > 0 && !state) return new Response("Invalid or expired run token; start the run again.", { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used = 0; }
  if (used >= DAILY_CAP) return new Response("Daily live-run cap reached; try a recorded run.", { status: 429 });
  used++;

  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        const emit = (e: Ev | { type: "state"; token: string; next: number }) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        try {
          const next = n === 0 ? await census(repo!, emit) : await round(state!, n, MAX_ROUNDS, emit);
          if (next) emit({ type: "state", token: sign(next, n + 1), next: n + 1 });
        } catch (e) { emit({ type: "error", msg: String(e instanceof Error ? e.message : e).slice(0, 300) }); }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } },
  );
}
