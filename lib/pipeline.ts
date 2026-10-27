// README Proof pipeline: census (Nano extracts steps, a Vercel Sandbox runs them) then a verify-and-retry fix loop (Ultra).
import { Sandbox } from "@vercel/sandbox";
import { NANO, ULTRA, ULTRA_PRICE, chat, tavily } from "./models";
import type { Ev } from "./types";

type Emit = (e: Ev) => void;
const DIR = "/tmp/repo";
const MAX_ROUNDS = 4;

export const ERR = /(Traceback|ModuleNotFoundError|ImportError|command not found|No such file|npm ERR|ERESOLVE|SyntaxError|Cannot find module|error:|fatal:)/i;
export const ENV_MISMATCH = /(EBADENGINE|EBADDEVENGINES|requires? (a )?(python|node)|python[ _]requires|Unsupported (engine|Python)|No matching distribution|requires-python)/i;
const PLACEHOLDER = /(\/path\/to|<[^>]+>|\byour[-_ ]|YOUR_|\bfoo\b|\bxxx+\b|example\.com|my-?project)/i;
const interactive = (s: string) => /^\s*(npm init|npm create|npx create|yarn create|pnpm create)\b/.test(s);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createSandbox(timeout: number) {
  for (let i = 0; i < 6; i++) {
    try { return await Sandbox.create({ persistent: false, timeout }); }
    catch (e) { if (!/rate.?limit/i.test(String(e))) throw e; await sleep(10_000 * (i + 1)); }
  }
  throw new Error("Sandbox creation rate limited, try again in a minute");
}

export function parseRepo(input: string): string | null {
  const m = input.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

export async function extractSteps(readme: string) {
  const { text, usage } = await chat(NANO, `Extract from this README the shell commands a new Linux user copies, in order, to INSTALL the project. If the README also shows a command like <tool> --version or --help, include it last.
RULES: pick ONE install method for an end user (prefer pip/pipx/npm; NEVER list alternative methods such as both npm and yarn), not building from source or contributing. Never include a TUI, server or watcher. Every command must appear VERBATIM in the README text; never invent or modify commands, imports or code. Skip commands needing API keys, accounts, Docker, a GUI, macOS/Windows only, system packages via sudo, placeholders (anything like /path/to, <name>, your-...), and sample terminal output. Max 6 commands. Reply with ONLY a JSON array of strings; [] if the README has no copy-paste install path.

README:
${readme.slice(0, 24000)}`, 4000);
  let steps: string[] = [];
  for (const a of [...text.matchAll(/\[[^\[\]]*\]/g)].map((m) => m[0]).reverse()) { try { steps = JSON.parse(a); break; } catch { /* try earlier array */ } }
  const rd = norm(readme);
  const defined = new Set<string>();
  steps = steps.filter((s) => typeof s === "string").map((s) => s.replace(/^\s*\$\s+/, "").trim()).filter((s) => {
    const vars = [...s.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})/g)].map((m) => m[1]);
    const assign = s.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
    const ok = rd.includes(norm(s)) && !PLACEHOLDER.test(s) && !interactive(s) && vars.every((v) => defined.has(v));
    if (ok && assign) defined.add(assign[1]);
    return ok;
  });
  // deterministic smoke check when the README showed only the install
  const last = steps[steps.length - 1];
  if (last) {
    const py = last.match(/\b(?:pip3?|pipx|python3? -m pip) install(?: --user)? ([A-Za-z][\w.-]*)\s*$/);
    const npm = last.match(/\bnpm (?:install|i)(?: -g| --global)? ([@A-Za-z][\w@./-]*)\s*$/);
    if (py && !steps.some((x) => /--(help|version)\b|-h\b|-V\b/.test(x))) steps.push(`(command -v ${py[1]} >/dev/null && ${py[1]} --help >/dev/null) || python3 -c "import ${py[1].replace(/-/g, "_")}"`);
    if (npm && !steps.some((x) => /--(help|version)\b/.test(x))) steps.push(`npm ls -g ${npm[1]} >/dev/null 2>&1 || npm ls ${npm[1]} >/dev/null`);
  }
  return { steps, tokens: usage.total_tokens ?? 0 };
}

export function upstreamQuery(step: string, log: string): string | null {
  const pkg =
    log.match(/No matching distribution found for ([A-Za-z0-9_.-]+)/)?.[1] ??
    log.match(/No module named '([A-Za-z0-9_]+)/)?.[1] ??
    step.match(/\b(?:pip3?|pipx|npm|npx)(?: -p)?(?: install| i)?(?: --user| -g)? ([@A-Za-z][\w@./-]*)/)?.[1];
  if (!pkg) return null;
  const what = /use_2to3|pkg_resources|distutils|imp\b|ast\.(Num|Str)|removed/i.test(log) ? "removed in Python 3.12 breaking change" : "install error release notes changelog";
  return `${pkg} ${what}`;
}

function verifyCommands(text: string): string[] {
  // take the bash fence after the "3. VERIFY" heading; the diff in section 2 can itself contain fences
  const i = text.search(/\n\s*\*{0,2}3\.\s*\*{0,2}VERIFY/i);
  const tail = i >= 0 ? text.slice(i) : text;
  const fences = [...tail.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((m) => m[1]);
  return (fences.at(-1) ?? "").split("\n").map((l) => l.replace(/^\s*\$\s*/, "")).filter((l) => l.trim() && !l.trim().startsWith("#") && !/^[+-]\s/.test(l));
}

export function parseAnswer(text: string) {
  const rootCause = (text.match(/1\.\s*\*{0,2}ROOT CAUSE:?\*{0,2}\s*([\s\S]*?)(?=\n\s*\*{0,2}2\.)/i)?.[1] ?? text.match(/ROOT CAUSE:?\*{0,2}\s*([^\n]+)/i)?.[1] ?? "").trim();
  // the patch can itself contain ``` fences (README code blocks), so cut the section between headings, not between fences
  const i2 = text.search(/\n\s*\*{0,2}2\.\s*\*{0,2}README PATCH/i), i3 = text.search(/\n\s*\*{0,2}3\.\s*\*{0,2}VERIFY/i);
  const lines = (i2 >= 0 ? text.slice(i2, i3 > i2 ? i3 : undefined) : text).split("\n");
  const from = lines.findIndex((l) => l.startsWith("--- ") || l.startsWith("diff "));
  let to = lines.length;
  while (to > from && !/^```\s*$/.test(lines[to - 1] ?? "")) to--;
  const patch = from >= 0 ? lines.slice(from, to > from + 1 ? to - 1 : lines.length).join("\n").trim() : "";
  return { rootCause, patch, cmds: verifyCommands(text) };
}

export async function runVerify(cmds: string[], seconds = 900) {
  const sb = await createSandbox(20 * 60_000);
  try {
    const script = ["set -eo pipefail", "export DEBIAN_FRONTEND=noninteractive", ...cmds].join("\n");
    await sb.writeFiles([{ path: "/tmp/verify.sh", content: Buffer.from(script) }]);
    const r = await sb.runCommand({ cmd: "bash", args: ["-lc", `cd /tmp; timeout ${seconds} bash -x /tmp/verify.sh > /tmp/verify.log 2>&1`] });
    const log = (await sb.readFileToBuffer({ path: "/tmp/verify.log" }))?.toString("utf8") ?? "";
    const lastOut = log.split("\n+ ").at(-1) ?? "";
    const ok = r.exitCode === 0 && !ERR.test(lastOut);
    return { ok, exit: r.exitCode, log: log.slice(-6000), evidence: ok ? "" : await evidence(sb, log) };
  } finally { await sb.stop().catch(() => {}); }
}

// real package-index lookups for names the failure mentioned, so Ultra cannot keep inventing packages
async function evidence(sb: Sandbox, log: string) {
  const pip = new Set<string>(), apt = new Set<string>();
  for (const m of log.matchAll(/(?:No matching distribution found for|requirement) ([A-Za-z0-9_.-]+)/g)) pip.add(m[1]);
  for (const m of log.matchAll(/No module named '([A-Za-z0-9_]+)/g)) pip.add(m[1]);
  for (const m of log.matchAll(/Unable to locate package ([A-Za-z0-9.+_-]+)/g)) apt.add(m[1]);
  const cmds = [
    ...[...pip].slice(0, 4).map((p) => `echo "## pip index versions ${p}"; pip index versions ${p} 2>&1 | head -3`),
    ...[...apt].slice(0, 4).map((a) => `echo "## apt-cache policy ${a}"; apt-cache policy ${a} 2>&1 | head -4`),
    'echo "## os"; head -2 /etc/os-release',
  ];
  const r = await sb.runCommand({ cmd: "bash", args: ["-lc", `timeout 25 sudo apt-get update -qq >/dev/null 2>&1; timeout 30 bash -c ${JSON.stringify(cmds.join("; "))}`] });
  return (await r.stdout()).slice(0, 3000);
}

export const RECIPES = `Facts about the verify machine: clean Ubuntu, non-root user with passwordless sudo, no Docker, no audio device, internet access. The verify script starts in an empty directory: clone the repository first if a step needs its files. You can only change the README (not source files or PyPI/npm packages).
Ubuntu recipes known to work there:
- apt package lists are EMPTY on the clean machine: every apt-get install must be preceded by \`sudo apt-get update\` (else 'Unable to locate package').
- add-apt-repository needs \`sudo apt-get install -y software-properties-common\` first.
- older Pythons: \`sudo add-apt-repository -y ppa:deadsnakes/ppa && sudo apt-get update\` then \`sudo apt-get install -y python3.X python3.X-venv python3.X-dev\` (there are NO python3.X-pip or python3.X-setuptools packages); then \`python3.X -m venv ~/venv && source ~/venv/bin/activate\`.
- compiling wheels needs \`sudo apt-get install -y build-essential python3-dev\`.
- \`pkg_resources\` is not a pip package; it ships with setuptools (removed in setuptools>=81, so pin \`setuptools<81\`).
- old packages whose pins fail with use_2to3 / distutils / imp / ast.Num need an OLDER Python from deadsnakes (try 3.8, then 3.7); the build also runs in an isolated env, so pin build tools with \`pip install --no-build-isolation\` only after installing setuptools and wheel in the venv.\n- prefer a venv over pip --user; Python 3.14 is the system default.`;

export async function runPipeline(repo: string, emit: Emit) {
  emit({ type: "start", repo });
  const sb = await createSandbox(10 * 60_000);
  let readme = "", file = "", tree = "";
  let steps: string[] = [];
  let failed: { step: string; tail: string } | null = null;
  try {
    emit({ type: "log", msg: "Cloning into a clean Vercel Sandbox (Ubuntu, Python 3.14, Node 24)" });
    const cl = await sb.runCommand("bash", ["-c", `git clone --depth 1 https://github.com/${repo} ${DIR} && ls ${DIR} | grep -i '^readme' | head -1 && git -C ${DIR} ls-files | head -300`]);
    if (cl.exitCode !== 0) { emit({ type: "error", msg: `Could not clone ${repo}: ${(await cl.stderr()).slice(0, 200)}` }); return; }
    const lines = (await cl.stdout()).split("\n");
    file = lines[0]; tree = lines.slice(1).join("\n");
    readme = (await sb.readFileToBuffer({ path: `${DIR}/${file}` }))?.toString("utf8") ?? "";
    emit({ type: "readme", file, bytes: readme.length });

    emit({ type: "log", msg: "Nemotron Nano reads the README and extracts the install path" });
    const ex = await extractSteps(readme);
    steps = ex.steps;
    emit({ type: "steps", steps, nanoTokens: ex.tokens });
    if (!steps.length) { emit({ type: "verdict", status: "no_steps" }); emit({ type: "result", fixed: false, rounds: 0, usd: 0, tokens: ex.tokens }); return; }

    const pre = 'export PATH="$HOME/.local/bin:$(npm prefix -g 2>/dev/null)/bin:$PATH"';
    for (let i = 0; i < steps.length; i++) {
      emit({ type: "step", i, status: "running" });
      const r = await sb.runCommand({ cmd: "bash", args: ["-lc", `${pre}; cd ${DIR}; timeout 120 bash -c ${JSON.stringify(steps[i])} 2>&1 | tail -c 1500; exit \${PIPESTATUS[0]}`], cwd: DIR });
      const out = await r.stdout();
      const alt = r.exitCode === 127 && /\b(yarn|pnpm|bun|brew|conda|apt|apt-get|snap|choco)\b/.test(steps[i]);
      const masked = r.exitCode === 0 && ERR.test(out);
      const bad = !alt && (r.exitCode !== 0 || masked);
      emit({ type: "step", i, status: alt ? "skipped" : bad ? "red" : "green", exit: r.exitCode, tail: out.slice(-700) });
      if (bad) { failed = { step: steps[i], tail: out.slice(-1500) }; break; }
    }
  } finally { await sb.stop().catch(() => {}); }

  if (!failed) { emit({ type: "verdict", status: "ok" }); emit({ type: "result", fixed: true, rounds: 0, usd: 0, tokens: 0 }); return; }
  const status = /\btimeout\b|^124$/.test(failed.tail) ? "inconclusive" : ENV_MISMATCH.test(failed.tail) ? "env_mismatch" : "broken";
  emit({ type: "verdict", status, failedStep: failed.step });

  // Tavily: look for upstream release notes explaining the failure
  let upstream = "";
  const q = upstreamQuery(failed.step, failed.tail);
  if (q) {
    try {
      const res = await tavily(q);
      if (res) { emit({ type: "tavily", query: q, results: res }); upstream = res.map((x) => `- ${x.title} (${x.url}): ${x.snippet}`).join("\n"); }
      else emit({ type: "tavily_skipped", reason: "TAVILY_API_KEY not set" });
    } catch (e) { emit({ type: "tavily_skipped", reason: String(e).slice(0, 120) }); }
  }

  let history = "", usd = 0, tokens = 0;
  for (let n = 1; n <= MAX_ROUNDS; n++) {
    emit({ type: "round", n, phase: "thinking" });
    const prompt = `A user followed this repository's README in a clean Ubuntu machine (Python 3.14, Node 24) and it failed.

REPO FILES (first 300):
${tree}

README (${file}):
${readme.slice(0, 40000)}

STEP THAT FAILED: ${failed.step}
OUTPUT (tail):
${failed.tail}
${upstream ? `\nUPSTREAM EVIDENCE FROM A WEB SEARCH (Tavily):\n${upstream}\n` : ""}${history}
${RECIPES}
Keep your thinking short; your final answer must start with the line \`1. ROOT CAUSE:\`.
Output:
1. ROOT CAUSE: one or two sentences.
2. README PATCH: a minimal unified diff against ${file} that makes the documented install path work for a new user today.
3. VERIFY: the exact shell commands (one per line, in ONE \`\`\`bash fence at the very end) that a clean machine runs to follow the patched README from scratch, ending with a command that proves the tool works (e.g. --help or --version). They run in one non-interactive bash script with set -e.`;
    const u = await chat(ULTRA, prompt, 12000);
    const text = u.text.includes("1. ROOT CAUSE:") ? u.text.slice(u.text.lastIndexOf("1. ROOT CAUSE:")) : u.text;
    const { rootCause, patch, cmds } = parseAnswer(text);
    const cost = (u.usage.prompt_tokens ?? 0) * ULTRA_PRICE.in + (u.usage.completion_tokens ?? 0) * ULTRA_PRICE.out;
    usd += cost; tokens += u.usage.total_tokens ?? 0;
    emit({ type: "round", n, phase: "answer", rootCause, patch, cmds, usd: +cost.toFixed(4), tokens: u.usage.total_tokens ?? 0 });
    if (!cmds.length) { history = `\nYOUR PREVIOUS ANSWER HAD NO \`\`\`bash VERIFY BLOCK. Include one.\n`; emit({ type: "round", n, phase: "red", log: "(no verify commands in the answer)" }); continue; }
    emit({ type: "round", n, phase: "verifying", cmds });
    const v = await runVerify(cmds);
    if (v.ok) {
      emit({ type: "round", n, phase: "green", log: v.log.slice(-1200) });
      emit({ type: "result", fixed: true, rounds: n, usd: +usd.toFixed(4), tokens, patch, cmds });
      return;
    }
    emit({ type: "round", n, phase: "red", log: v.log.slice(-1500) });
    history = `\nYOUR PREVIOUS FIX (round ${n}):\n${text.slice(0, 6000)}\n\nWE RAN YOUR VERIFY COMMANDS IN A CLEAN SANDBOX (exit ${v.exit}). OUTPUT TAIL:\n${v.log.slice(-3500)}\n\nREAL PACKAGE-INDEX EVIDENCE FROM THAT MACHINE:\n${v.evidence}\n\nThat did not work. Use this evidence; do not repeat the same mistake.\n`;
  }
  emit({ type: "result", fixed: false, rounds: MAX_ROUNDS, usd: +usd.toFixed(4), tokens });
}
