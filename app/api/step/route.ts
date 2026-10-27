import { parseRepo } from "@/lib/pipeline";
import { census, round, type RunState } from "@/lib/stages";
import type { Ev } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_ROUNDS = 4;
// Abuse guard for a public demo that spends model credits and sandbox time.
let day = "", used = 0;
const DAILY_CAP = Number(process.env.LIVE_DAILY_CAP ?? 40);

// NDJSON stream; the last line is {"type":"state", ...} when the client should call the next round.
export async function POST(req: Request) {
  if (process.env.LIVE_ENABLED === "false") return new Response("Live runs are disabled on this deployment; try a recorded run.", { status: 503 });
  const body = await req.json().catch(() => ({}));
  const n = Number(body.round ?? 0);
  if (n === 0) {
    const today = new Date().toISOString().slice(0, 10);
    if (day !== today) { day = today; used = 0; }
    if (used >= DAILY_CAP) return new Response("Daily live-run cap reached; try a recorded run.", { status: 429 });
    used++;
  }
  const repo = n === 0 ? parseRepo(String(body.repo ?? "")) : null;
  if (n === 0 && !repo) return new Response("Enter a GitHub URL like https://github.com/owner/name", { status: 400 });
  if (n > MAX_ROUNDS || (n > 0 && !body.state)) return new Response("bad request", { status: 400 });

  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        const emit = (e: Ev | { type: "state"; state: RunState; next: number }) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        try {
          const next = n === 0 ? await census(repo!, emit) : await round(body.state as RunState, n, MAX_ROUNDS, emit);
          if (next) emit({ type: "state", state: next, next: n + 1 });
        } catch (e) { emit({ type: "error", msg: String(e instanceof Error ? e.message : e).slice(0, 300) }); }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } },
  );
}
