// The live pipeline split into short stages so each request fits a 300 s Vercel Function: the browser calls
// census once, then one fix round per request, carrying the state between calls.
import { ULTRA, ULTRA_PRICE, chat, tavily } from "./models";
import { ENV_MISMATCH, ERR, RECIPES, createSandbox, extractSteps, parseAnswer, runVerify, upstreamQuery } from "./pipeline";
import type { Ev } from "./types";

type Emit = (e: Ev) => void;
const DIR = "/tmp/repo";

export type RunState = {
  repo: string; file: string; readme: string; tree: string;
  failed: { step: string; tail: string }; upstream: string; history: string; usd: number; tokens: number;
};

export async function census(repo: string, emit: Emit): Promise<RunState | null> {
  emit({ type: "start", repo });
  const sb = await createSandbox(5 * 60_000);
  let readme = "", file = "", tree = "", failed: RunState["failed"] | null = null;
  try {
    emit({ type: "log", msg: "Cloning into a clean Vercel Sandbox (Ubuntu, Python 3.14, Node 24)" });
    const cl = await sb.runCommand("bash", ["-c", `git clone --depth 1 https://github.com/${repo} ${DIR} && ls ${DIR} | grep -i '^readme' | head -1 && git -C ${DIR} ls-files | head -300`]);
    if (cl.exitCode !== 0) { emit({ type: "error", msg: `Could not clone ${repo}` }); return null; }
    const lines = (await cl.stdout()).split("\n");
    file = lines[0]; tree = lines.slice(1).join("\n");
    readme = (await sb.readFileToBuffer({ path: `${DIR}/${file}` }))?.toString("utf8") ?? "";
    emit({ type: "readme", file, bytes: readme.length });
    emit({ type: "log", msg: "Nemotron Nano reads the README and extracts the install path" });
    const { steps, tokens } = await extractSteps(readme);
    emit({ type: "steps", steps, nanoTokens: tokens });
    if (!steps.length) { emit({ type: "verdict", status: "no_steps" }); emit({ type: "result", fixed: false, rounds: 0, usd: 0, tokens }); return null; }
    const pre = 'export PATH="$HOME/.local/bin:$(npm prefix -g 2>/dev/null)/bin:$PATH"';
    for (let i = 0; i < steps.length; i++) {
      emit({ type: "step", i, status: "running" });
      const r = await sb.runCommand({ cmd: "bash", args: ["-lc", `${pre}; cd ${DIR}; timeout 90 bash -c ${JSON.stringify(steps[i])} 2>&1 | tail -c 1500; exit \${PIPESTATUS[0]}`], cwd: DIR });
      const out = await r.stdout();
      const alt = r.exitCode === 127 && /\b(yarn|pnpm|bun|brew|conda|apt|apt-get|snap|choco)\b/.test(steps[i]);
      const bad = !alt && (r.exitCode !== 0 || ERR.test(out));
      emit({ type: "step", i, status: alt ? "skipped" : bad ? "red" : "green", exit: r.exitCode, tail: out.slice(-700) });
      if (bad) { failed = { step: steps[i], tail: out.slice(-1500) }; break; }
    }
  } finally { await sb.stop().catch(() => {}); }

  if (!failed) { emit({ type: "verdict", status: "ok" }); emit({ type: "result", fixed: true, rounds: 0, usd: 0, tokens: 0 }); return null; }
  emit({ type: "verdict", status: ENV_MISMATCH.test(failed.tail) ? "env_mismatch" : "broken", failedStep: failed.step });

  let upstream = "";
  const q = upstreamQuery(failed.step, failed.tail);
  if (q) {
    try {
      const res = await tavily(q);
      if (res) { emit({ type: "tavily", query: q, results: res }); upstream = res.map((x) => `- ${x.title} (${x.url}): ${x.snippet}`).join("\n"); }
      else emit({ type: "tavily_skipped", reason: "TAVILY_API_KEY not set" });
    } catch (e) { emit({ type: "tavily_skipped", reason: String(e).slice(0, 120) }); }
  }
  return { repo, file, readme, tree, failed, upstream, history: "", usd: 0, tokens: 0 };
}

// One Ultra proposal + one sandbox verification. Returns the state for the next round, or null when finished.
export async function round(st: RunState, n: number, maxRounds: number, emit: Emit): Promise<RunState | null> {
  emit({ type: "round", n, phase: "thinking" });
  const prompt = `A user followed this repository's README in a clean Ubuntu machine (Python 3.14, Node 24) and it failed.

REPO FILES (first 300):
${st.tree}

README (${st.file}):
${st.readme.slice(0, 40000)}

STEP THAT FAILED: ${st.failed.step}
OUTPUT (tail):
${st.failed.tail}
${st.upstream ? `\nUPSTREAM EVIDENCE FROM A WEB SEARCH (Tavily):\n${st.upstream}\n` : ""}${st.history}
${RECIPES}
Keep your thinking short; your final answer must start with the line \`1. ROOT CAUSE:\`.
Output:
1. ROOT CAUSE: one or two sentences.
2. README PATCH: a minimal unified diff against ${st.file} that makes the documented install path work for a new user today.
3. VERIFY: the exact shell commands (one per line, in ONE \`\`\`bash fence at the very end) that a clean machine runs to follow the patched README from scratch, ending with a command that proves the tool works (e.g. --help or --version). They run in one non-interactive bash script with set -e and must finish within 2 minutes.`;
  const u = await chat(ULTRA, prompt, 6000); // live budget: Ultra + verify must fit one 300 s function
  const text = u.text.includes("1. ROOT CAUSE:") ? u.text.slice(u.text.lastIndexOf("1. ROOT CAUSE:")) : u.text;
  const { rootCause, patch, cmds } = parseAnswer(text);
  const cost = (u.usage.prompt_tokens ?? 0) * ULTRA_PRICE.in + (u.usage.completion_tokens ?? 0) * ULTRA_PRICE.out;
  const usd = st.usd + cost, tokens = st.tokens + (u.usage.total_tokens ?? 0);
  emit({ type: "round", n, phase: "answer", rootCause, patch, cmds, usd: +cost.toFixed(4), tokens: u.usage.total_tokens ?? 0 });
  if (!cmds.length) {
    emit({ type: "round", n, phase: "red", log: "(no verify commands in the answer)" });
    if (n >= maxRounds) { emit({ type: "result", fixed: false, rounds: n, usd: +usd.toFixed(4), tokens }); return null; }
    return { ...st, usd, tokens, history: "\nYOUR PREVIOUS ANSWER HAD NO ```bash VERIFY BLOCK. Include one.\n" };
  }
  emit({ type: "round", n, phase: "verifying", cmds });
  const v = await runVerify(cmds, 120);
  if (v.ok) {
    emit({ type: "round", n, phase: "green", log: v.log.slice(-1200) });
    emit({ type: "result", fixed: true, rounds: n, usd: +usd.toFixed(4), tokens, patch, cmds });
    return null;
  }
  emit({ type: "round", n, phase: "red", log: v.log.slice(-1500) });
  if (n >= maxRounds) { emit({ type: "result", fixed: false, rounds: n, usd: +usd.toFixed(4), tokens }); return null; }
  const timedOut = v.exit === 124 ? "\nThe verify script hit the 2-minute limit; choose a faster path (fewer packages, binary wheels).\n" : "";
  return { ...st, usd, tokens, history: `\nYOUR PREVIOUS FIX (round ${n}):\n${text.slice(0, 6000)}\n\nWE RAN YOUR VERIFY COMMANDS IN A CLEAN SANDBOX (exit ${v.exit}). OUTPUT TAIL:\n${v.log.slice(-3500)}\n${timedOut}\nREAL PACKAGE-INDEX EVIDENCE FROM THAT MACHINE:\n${v.evidence}\n\nThat did not work. Use this evidence; do not repeat the same mistake.\n` };
}
