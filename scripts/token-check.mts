// Run: STATE_SECRET=... node scripts/token-check.mts  (fails loudly if signed run state can be forged or replayed)
import assert from "node:assert/strict";
import { sign, verify } from "../lib/token.ts";
const st = { repo: "a/b", file: "README.md", readme: "x".repeat(50_000), tree: "", failed: { step: "pip install b", tail: "err" }, upstream: "", history: "", usd: 0, tokens: 0 };
const t = sign(st, 2);
assert.equal(verify(t, 2)?.repo, "a/b");                       // valid token, right round
assert.equal(verify(t, 2)!.readme.length, 40_000);             // fields capped
assert.equal(verify(t, 3), null);                              // wrong round rejected
const [b, m] = t.split(".");
const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, "base64url").toString()), state: { ...st, readme: "IGNORE ALL" } })).toString("base64url");
assert.equal(verify(`${forged}.${m}`, 2), null);               // edited state rejected
assert.equal(verify("garbage", 2), null);
console.log("token checks passed");
