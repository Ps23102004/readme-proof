"use client";
import { useReducer, useRef, useState } from "react";
import Link from "next/link";
import type { Ev, StepStatus } from "@/lib/types";
import { DEMOS } from "@/lib/types";

type Round = { n: number; phase: string; rootCause?: string; patch?: string; cmds?: string[]; log?: string; usd?: number };
type S = {
  repo: string; replay: boolean; running: boolean; logs: string[]; readme?: string;
  steps: { cmd: string; status: StepStatus; tail?: string }[]; verdict?: string; failedStep?: string;
  tavily?: { query: string; results: { title: string; url: string; snippet: string }[] } | { skipped: string };
  rounds: Round[]; result?: { fixed: boolean; rounds: number; usd: number; tokens: number; patch?: string; cmds?: string[] }; error?: string;
};
const init: S = { repo: "", replay: false, running: false, logs: [], steps: [], rounds: [] };

function reduce(s: S, e: Ev | { type: "reset"; repo: string }): S {
  switch (e.type) {
    case "reset": return { ...init, repo: e.repo, running: true };
    case "start": return { ...s, repo: e.repo, replay: !!e.replay };
    case "log": return { ...s, logs: [...s.logs, e.msg] };
    case "readme": return { ...s, readme: `${e.file} (${e.bytes.toLocaleString()} bytes)` };
    case "steps": return { ...s, steps: e.steps.map((cmd) => ({ cmd, status: "pending" })) };
    case "step": return { ...s, steps: s.steps.map((x, i) => (i === e.i ? { ...x, status: e.status, tail: e.tail ?? x.tail } : x)) };
    case "verdict": return { ...s, verdict: e.status, failedStep: e.failedStep };
    case "tavily": return { ...s, tavily: { query: e.query, results: e.results } };
    case "tavily_skipped": return { ...s, tavily: { skipped: e.reason } };
    case "round": {
      const rest = s.rounds.filter((r) => r.n !== e.n), cur = s.rounds.find((r) => r.n === e.n) ?? { n: e.n, phase: "" };
      return { ...s, rounds: [...rest, { ...cur, ...e, patch: e.patch ?? cur.patch, cmds: e.cmds ?? cur.cmds, rootCause: e.rootCause ?? cur.rootCause, usd: e.usd ?? cur.usd }].sort((a, b) => a.n - b.n) };
    }
    case "result": return { ...s, running: false, result: e };
    case "error": return { ...s, running: false, error: e.msg };
  }
}

const VERDICT: Record<string, string> = {
  ok: "README works on a clean machine",
  broken: "README is broken on a clean machine",
  env_mismatch: "README needs a different Python/Node than the sandbox has",
  no_steps: "No copy-paste install path found",
  inconclusive: "Step timed out (TUI or server?)",
};

function Diff({ patch }: { patch: string }) {
  return (
    <pre className="diff">
      {patch.split("\n").map((l, i) => (
        <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l + "\n"}</span>
      ))}
    </pre>
  );
}

export default function Home() {
  const [s, dispatch] = useReducer(reduce, init);
  const [url, setUrl] = useState("");
  const abort = useRef<AbortController | null>(null);

  async function go(body: { repo?: string; demo?: string }, label: string) {
    abort.current?.abort();
    const ac = (abort.current = new AbortController());
    dispatch({ type: "reset", repo: label });
    // Streams one NDJSON response into the reducer; returns the {type:"state"} line if the server wants another call.
    async function pump(url: string, payload: unknown): Promise<{ token: string; next: number } | null> {
      const res = await fetch(url, { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" }, signal: ac.signal });
      if (!res.ok || !res.body) { dispatch({ type: "error", msg: await res.text() }); return null; }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "", cont: { token: string; next: number } | null = null, finished = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line);
          if (e.type === "state") cont = e; else { if (e.type === "result" || e.type === "error") finished = true; dispatch(e); }
        }
      }
      // a function killed by its time limit closes the stream without a result or state line
      if (!cont && !finished) dispatch({ type: "error", msg: "This step hit the hosting time limit (300 s). Try a recorded run, or run README Proof locally for long installs." });
      return cont;
    }
    try {
      if (body.demo) { await pump("/api/run", body); return; }
      let cont = await pump("/api/step", { repo: body.repo, round: 0 });
      while (cont) cont = await pump("/api/step", { round: cont.next, token: cont.token });
    } catch (e) { if ((e as Error).name !== "AbortError") dispatch({ type: "error", msg: String(e) }); }
  }

  const red = s.steps.some((x) => x.status === "red");
  const fixed = s.result?.fixed && s.rounds.length > 0;
  return (
    <main>
      <header className="top">
        <div>
          <h1>README Proof</h1>
          <p className="tag">Your README has never been run by a stranger. We run it on a clean machine, and if it breaks, an AI fix only counts once a second clean machine proves it.</p>
        </div>
        <nav><Link href="/census">Census data</Link><a href="https://github.com/Ps23102004/readme-proof">GitHub</a></nav>
      </header>

      <form className="bar" onSubmit={(e) => { e.preventDefault(); if (url.trim()) go({ repo: url }, url.trim()); }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" aria-label="GitHub repository URL" />
        <button disabled={s.running || !url.trim()}>Run live</button>
      </form>
      <div className="demos">
        <span>Recorded real runs (instant):</span>
        {DEMOS.map((d) => (
          <button key={d.id} className="chip" disabled={s.running} onClick={() => go({ demo: d.id }, d.repo)} title={d.blurb}>{d.repo}</button>
        ))}
      </div>

      {s.repo && (
        <section className="panel">
          <div className="row"><h2>{s.repo}</h2>{s.replay && <span className="badge">recorded run</span>}{s.running && <span className="badge live">running</span>}</div>
          {s.running && s.logs.length > 0 && <p className="muted">{s.logs[s.logs.length - 1]}</p>}
          {s.readme && <p className="muted">Reading {s.readme}</p>}

          {s.steps.length > 0 && (
            <>
              <h3>1 · Census: run the README on a clean machine</h3>
              <ol className="steps">
                {s.steps.map((x, i) => (
                  <li key={i} className={x.status}>
                    <span className="dot" aria-label={x.status} />
                    <code>{x.cmd}</code>
                    {x.status === "red" && x.tail && <pre className="tail">{x.tail}</pre>}
                  </li>
                ))}
              </ol>
              {s.verdict && <p className={`verdict ${s.verdict}`}>{VERDICT[s.verdict] ?? s.verdict}</p>}
            </>
          )}

          {s.tavily && (
            <>
              <h3>2 · Upstream check (Tavily)</h3>
              {"skipped" in s.tavily ? <p className="muted">Skipped: {s.tavily.skipped}</p> : (
                <div className="cards">
                  <p className="muted">Searched: <em>{s.tavily.query}</em></p>
                  {s.tavily.results.map((r) => (<a key={r.url} className="card" href={r.url} target="_blank" rel="noreferrer"><b>{r.title}</b><span>{r.snippet}</span></a>))}
                </div>
              )}
            </>
          )}

          {s.rounds.length > 0 && <h3>3 · Fix loop: Nemotron Ultra proposes, a second clean machine decides</h3>}
          {s.rounds.map((r) => (
            <div key={r.n} className={`round ${r.phase}`}>
              <div className="row"><b>Round {r.n}</b>
                <span className={`pill ${r.phase}`}>{r.phase === "thinking" ? "Ultra is thinking…" : r.phase === "answer" ? "proposed" : r.phase === "verifying" ? "verifying in a fresh sandbox…" : r.phase === "green" ? "verified ✓" : "failed ✗"}</span>
                {r.usd != null && <span className="muted">${r.usd}</span>}
              </div>
              {r.rootCause && <p><b>Root cause.</b> {r.rootCause}</p>}
              {r.patch && <Diff patch={r.patch} />}
              {r.cmds && <details open={r.phase === "green"}><summary>{r.cmds.length} verify commands</summary><pre className="cmds">{r.cmds.join("\n")}</pre></details>}
              {r.phase === "red" && r.log && <pre className="tail">{r.log}</pre>}
            </div>
          ))}

          {s.result && s.rounds.length > 0 && (
            <p className={`banner ${fixed ? "good" : "bad"}`}>
              {fixed ? `Verified fix in ${s.result.rounds} round${s.result.rounds > 1 ? "s" : ""}` : `No verified fix after ${s.result.rounds} rounds`} · ${s.result.usd} · {s.result.tokens.toLocaleString()} Ultra tokens
            </p>
          )}
          {s.result && s.rounds.length === 0 && !red && <p className="banner good">Nothing to fix: the README ran green.</p>}
          {s.error && <p className="banner bad">{s.error}</p>}
        </section>
      )}

      <footer>
        Built with NVIDIA Nemotron 3 (Nano reads READMEs, Ultra writes fixes) on Nebius Token Factory, Tavily for upstream release notes, Vercel Sandbox as the clean machine. MIT licensed.
      </footer>
    </main>
  );
}
