// Verify-and-retry fix loop: Ultra proposes README fix + verify commands, a clean sandbox runs them, failure log goes back. Max 4 rounds.
// Usage: node --env-file=.env --env-file=.env.local loop.mjs data/census-stale30-2026-10-27.jsonl out.jsonl repo1 repo2 ...
import { Sandbox } from "@vercel/sandbox";
const createRetry = async (opts) => { for (let i = 0; i < 8; i++) { try { return await Sandbox.create(opts); } catch (e) { if (!/rate.?limit/i.test(String(e))) throw e; await new Promise((r) => setTimeout(r, 15000 * (i + 1))); } } throw new Error("sandbox create rate limited"); };
import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ headersTimeout: 15 * 60_000, bodyTimeout: 15 * 60_000 }));
import { readFileSync, appendFileSync } from "node:fs";

const [census, outFile, ...repos] = process.argv.slice(2);
const rows = Object.fromEntries(readFileSync(census, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.repo, r]));
const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
const PRICE = { in: 1 / 1e6, out: 3 / 1e6 }; // USD per token, Ultra on Token Factory (aggregator figures, unverified)
const DIR = "/tmp/repo";
const ERR = /(Traceback|ModuleNotFoundError|ImportError|command not found|No such file|npm ERR|ERESOLVE|SyntaxError|Cannot find module|fatal:|E: Unable|Error:)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ultra(prompt) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch("https://api.tokenfactory.nebius.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: ULTRA, max_tokens: 20000, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json();
    if (r.status === 429) { await sleep(30_000 * (attempt + 1)); continue; }
    const text = j.choices?.[0]?.message?.content ?? "";
    return { text: text.includes("1. ROOT CAUSE:") ? text.slice(text.lastIndexOf("1. ROOT CAUSE:")) : text, usage: j.usage ?? {} };
  }
  throw new Error("ultra rate limited");
}

function verifyCommands(text) {
  const fences = [...text.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((m) => m[1]);
  return (fences.at(-1) ?? "").split("\n").map((l) => l.replace(/^\s*\$\s*/, "")).filter((l) => l.trim() && !l.trim().startsWith("#"));
}

async function runVerify(cmds) {
  const sb = await createRetry({ persistent: false, timeout: 20 * 60_000 });
  try {
    const script = ["set -eo pipefail", "export DEBIAN_FRONTEND=noninteractive", ...cmds].join("\n");
    await sb.writeFiles([{ path: "/tmp/verify.sh", content: Buffer.from(script) }]);
    // log to a file and read it back: piping through tail lost output when the step was killed
    const r = await sb.runCommand({ cmd: "bash", args: ["-lc", "cd /tmp; timeout 900 bash -x /tmp/verify.sh > /tmp/verify.log 2>&1"] });
    const log = (await sb.readFileToBuffer({ path: "/tmp/verify.log" }))?.toString("utf8") ?? "";
    const lastOut = log.split("\n+ ").at(-1) ?? "";
    const ok = r.exitCode === 0 && !ERR.test(lastOut);
    return { ok, exit: r.exitCode, log: log.slice(-6000), evidence: ok ? "" : await evidence(sb, log) };
  } finally {
    await sb.stop().catch(() => {});
  }
}

// Real package-index lookups for names the failure complained about, so Ultra cannot keep inventing packages.
async function evidence(sb, log) {
  const pip = new Set(), apt = new Set();
  for (const m of log.matchAll(/(?:No matching distribution found for|requirement) ([A-Za-z0-9_.-]+)/g)) pip.add(m[1]);
  for (const m of log.matchAll(/No module named '([A-Za-z0-9_]+)/g)) pip.add(m[1]);
  for (const m of log.matchAll(/(?:Unable to locate package|find any package by glob '|command not found: |: ([a-z0-9-]+): command not found)([A-Za-z0-9.+_-]*)/g)) apt.add(m[1] || m[2]);
  for (const m of log.matchAll(/'([a-z0-9+_-]+)': No such file|\[Errno 2\] No such file or directory: '([a-z0-9_.+-]+)'/g)) apt.add(m[1] || m[2]);
  const cmds = [
    ...[...pip].filter(Boolean).slice(0, 4).map((p) => `echo "## pip index versions ${p}"; pip index versions ${p} 2>&1 | head -3`),
    ...[...apt].filter(Boolean).slice(0, 4).map((a) => `echo "## apt-cache policy / search ${a}"; apt-cache policy ${a} 2>&1 | head -4; apt-cache search --names-only "^${a}" 2>&1 | head -3; echo "## which package provides ${a}"; apt-file search -x "bin/${a}$" 2>/dev/null | head -2`),
    'echo "## python versions available"; ls /usr/bin/python3* 2>/dev/null | head; echo "## os"; head -2 /etc/os-release',
  ];
  const r = await sb.runCommand({ cmd: "bash", args: ["-lc", `sudo apt-get update -qq >/dev/null 2>&1; ${cmds.join("; ")}`] });
  return (await r.stdout()).slice(0, 3000);
}

async function fixRepo(repo) {
  const c = rows[repo];
  const failed = c.steps.find((s) => s.exit !== 0 || s.masked);
  const sb = await createRetry({ persistent: false, timeout: 5 * 60_000 });
  let readme, file, tree;
  try {
    const cl = await sb.runCommand("bash", ["-c", `git clone --depth 1 https://github.com/${repo} ${DIR} && ls ${DIR} | grep -i '^readme' | head -1 && git -C ${DIR} ls-files | head -300`]);
    const lines = (await cl.stdout()).split("\n");
    file = lines[0];
    tree = lines.slice(1).join("\n");
    readme = (await sb.readFileToBuffer({ path: `${DIR}/${file}` }))?.toString("utf8") ?? "";
  } finally { await sb.stop().catch(() => {}); }

  const rounds = [];
  let history = "";
  for (let n = 1; n <= 4; n++) {
    const prompt = `A user followed this repository's README in a clean Ubuntu machine (Python 3.14, Node 24) and it failed.

REPO FILES (first 300):
${tree}

README (${file}):
${readme.slice(0, 40000)}

STEP THAT FAILED: ${failed.step}
OUTPUT (tail):
${failed.tail}
${history}
Facts about the verify machine: clean Ubuntu, non-root user with passwordless sudo, no Docker, internet access.
Ubuntu recipes that are known to work there:
- apt package lists are EMPTY on the clean machine: every apt-get install must be preceded by \`sudo apt-get update\` (else 'Unable to locate package').\n- add-apt-repository needs \`sudo apt-get install -y software-properties-common\` first.
- older Pythons: \`sudo add-apt-repository -y ppa:deadsnakes/ppa && sudo apt-get update\` then \`sudo apt-get install -y python3.X python3.X-venv python3.X-dev\` (there are NO python3.X-pip or python3.X-setuptools packages); then \`python3.X -m venv ~/venv && source ~/venv/bin/activate\`.
- compiling wheels needs \`sudo apt-get install -y build-essential python3-dev\` (g++, gcc, make).
- \`pkg_resources\` is not a pip package; it ships with setuptools (removed in setuptools>=81, so pin \`setuptools<81\`).
- prefer a venv over pip --user; Python 3.14 is the system default. You can only change the README (not source files or PyPI/npm packages). Keep your thinking short; your final answer must start with the line \`1. ROOT CAUSE:\`.
Output:
1. ROOT CAUSE: one or two sentences.
2. README PATCH: a minimal unified diff against ${file} that makes the documented install path work for a new user today.
3. VERIFY: the exact shell commands (one per line, in ONE \`\`\`bash fence at the very end) that a clean machine runs to follow the patched README from scratch, ending with a command that proves the tool works (e.g. --help or --version). Commands run in one non-interactive bash script with set -e; do not use interactive prompts.`;
    const u = await ultra(prompt);
    const cmds = verifyCommands(u.text);
    const v = cmds.length ? await runVerify(cmds) : { ok: false, exit: -1, log: "(no verify commands in answer)" };
    const cost = (u.usage.prompt_tokens ?? 0) * PRICE.in + (u.usage.completion_tokens ?? 0) * PRICE.out;
    rounds.push({ n, ok: v.ok, exit: v.exit, cmds, evidence: v.evidence, tokens: u.usage, usd: +cost.toFixed(4), answer: u.text, log: v.log.slice(-3000) });
    if (v.ok) break;
    history = `\nYOUR PREVIOUS FIX (round ${n}):\n${u.text.slice(0, 6000)}\n\nWE RAN YOUR VERIFY COMMANDS IN A CLEAN SANDBOX (exit ${v.exit}). OUTPUT TAIL:\n${v.log.slice(-3500)}\n\nREAL PACKAGE-INDEX EVIDENCE FROM THAT MACHINE:\n${v.evidence}\n\nThat did not work. Use this evidence; do not repeat the same mistake.\n`;
  }
  return { repo, fixed: rounds.at(-1).ok, rounds: rounds.length, usd: +rounds.reduce((a, r) => a + r.usd, 0).toFixed(4), tokens: rounds.reduce((a, r) => a + (r.tokens.total_tokens ?? 0), 0), detail: rounds };
}

await Promise.all(repos.map(async (repo) => {
  try {
    const res = await fixRepo(repo);
    appendFileSync(outFile, JSON.stringify(res) + "\n");
    console.log(res.fixed ? "FIXED " : "FAILED", `${res.rounds} round(s)`, `$${res.usd}`, `${res.tokens} tok`, repo);
  } catch (e) {
    console.log("ERROR ", repo, String(e).slice(0, 150));
  }
}));
