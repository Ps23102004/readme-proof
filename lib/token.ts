// HMAC-signed run state: the browser carries it between rounds but cannot forge or edit it.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RunState } from "./stages";

const TTL_MS = 30 * 60_000;
// size caps applied before anything reaches a prompt
const CAP = { readme: 40_000, tree: 20_000, tail: 4_000, upstream: 4_000, history: 14_000 };

function key() {
  const k = process.env.STATE_SECRET;
  if (!k || k.length < 32) throw new Error("STATE_SECRET is not configured");
  return k;
}

export function clampState(s: RunState): RunState {
  return {
    ...s,
    readme: s.readme.slice(0, CAP.readme), tree: s.tree.slice(0, CAP.tree), upstream: s.upstream.slice(0, CAP.upstream),
    history: s.history.slice(-CAP.history), failed: { step: s.failed.step.slice(0, 500), tail: s.failed.tail.slice(-CAP.tail) },
  };
}

export function sign(state: RunState, next: number): string {
  const body = Buffer.from(JSON.stringify({ state: clampState(state), next, exp: Date.now() + TTL_MS })).toString("base64url");
  return `${body}.${createHmac("sha256", key()).update(body).digest("base64url")}`;
}

export function verify(token: unknown, round: number): RunState | null {
  if (typeof token !== "string" || token.length > 200_000) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", key()).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (p.next !== round || Date.now() > p.exp) return null;
  return clampState(p.state as RunState);
}
