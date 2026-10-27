import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseRepo, runPipeline } from "@/lib/pipeline";
import type { Ev } from "@/lib/types";
import { DEMOS } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

// Abuse guard for a public demo that spends model credits and sandbox time: one live run at a time per instance, daily cap.
let busy = false;
let day = "", used = 0;
const DAILY_CAP = Number(process.env.LIVE_DAILY_CAP ?? 40);

function stream(producer: (emit: (e: Ev) => void) => Promise<void>) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        const emit = (e: Ev) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        try { await producer(emit); } catch (e) { emit({ type: "error", msg: String(e instanceof Error ? e.message : e).slice(0, 300) }); }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } },
  );
}

// Replay a recorded real run (events captured from a live run, long waits compressed) so the demo never sits on a spinner.
async function replay(id: string) {
  const demo = DEMOS.find((d) => d.id === id);
  if (!demo) return new Response("unknown demo", { status: 404 });
  const raw = await readFile(path.join(process.cwd(), "data", "demo", `${id}.ndjson`), "utf8");
  const events: (Ev & { t?: number })[] = raw.trim().split("\n").map((l) => JSON.parse(l));
  return stream(async (emit) => {
    let prev = 0;
    for (const e of events) {
      const t = e.t ?? prev;
      await new Promise((r) => setTimeout(r, Math.min(Math.max(t - prev, 0), 2500) * 0.6));
      prev = t;
      const { t: _t, ...rest } = e;
      emit(e.type === "start" ? { ...(rest as Ev), replay: true } as Ev : (rest as Ev));
    }
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body.demo) return replay(String(body.demo));
  // one long request only for local recording; hosted live runs go through /api/step in short stages
  if (process.env.RECORD !== "1") return new Response("Use /api/step for live runs.", { status: 400 });
  const repo = parseRepo(String(body.repo ?? ""));
  if (!repo) return new Response("Enter a GitHub URL like https://github.com/owner/name", { status: 400 });
  if (process.env.LIVE_ENABLED === "false") return new Response("Live runs are disabled on this deployment; try a recorded demo.", { status: 503 });
  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used = 0; }
  if (used >= DAILY_CAP) return new Response("Daily live-run cap reached; try a recorded demo.", { status: 429 });
  if (busy) return new Response("Another live run is in progress; try again in a minute or use a recorded demo.", { status: 429 });
  busy = true; used++;
  const start = Date.now();
  return stream(async (emit) => {
    try {
      await runPipeline(repo, (e) => emit(process.env.RECORD === "1" ? ({ ...e, t: Date.now() - start } as unknown as Ev) : e));
    } finally { busy = false; }
  });
}
