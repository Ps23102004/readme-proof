// Nebius Token Factory (OpenAI-compatible) calls to NVIDIA Nemotron models, and Tavily search.
import { Agent, setGlobalDispatcher } from "undici";

// Ultra can think for minutes before the first byte; undici's default 5 min header timeout drops those calls.
setGlobalDispatcher(new Agent({ headersTimeout: 15 * 60_000, bodyTimeout: 15 * 60_000 }));

export const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
export const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
// USD per token, Ultra on Token Factory (aggregator-listed prices, not confirmed by Nebius)
export const ULTRA_PRICE = { in: 1 / 1e6, out: 3 / 1e6 };

const BASE = "https://api.tokenfactory.nebius.com/v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

export async function chat(model: string, content: string, maxTokens: number): Promise<{ text: string; usage: Usage }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0, messages: [{ role: "user", content }] }),
    });
    if (r.status === 429) { await sleep(20_000 * (attempt + 1)); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(`Token Factory ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return { text: j.choices?.[0]?.message?.content ?? "", usage: j.usage ?? {} };
  }
  throw new Error("Token Factory rate limited");
}

export async function tavily(query: string): Promise<{ title: string; url: string; snippet: string }[] | null> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: 4, search_depth: "basic" }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}`);
  const j = await r.json();
  return (j.results ?? []).map((x: { title: string; url: string; content: string }) => ({ title: x.title, url: x.url, snippet: (x.content ?? "").slice(0, 320) }));
}
