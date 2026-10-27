// README census: Nano extracts install+smoke commands (verbatim from README only), a Vercel Sandbox runs them, JSONL out.
// Usage: node --env-file=.env --env-file=.env.local census.mjs repos.txt out.jsonl [concurrency]
// Statuses: ok | inconclusive (step timed out: TUI/server) | readme_break | env_mismatch (needs newer Node/Python than sandbox, README may not say so)
//           | no_steps (classifier found nothing) | clone_failed | error (sandbox/infra)
import { Sandbox } from "@vercel/sandbox";
const createRetry = async (opts) => { for (let i = 0; i < 8; i++) { try { return await Sandbox.create(opts); } catch (e) { if (!/rate.?limit/i.test(String(e))) throw e; await new Promise((r) => setTimeout(r, 15000 * (i + 1))); } } throw new Error("sandbox create rate limited"); };
import { readFileSync, appendFileSync } from "node:fs";

const [listFile, outFile, conc = "4"] = process.argv.slice(2);
const repos = readFileSync(listFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
const DIR = "/tmp/repo";
const ERR = /(Traceback|ModuleNotFoundError|ImportError|command not found|No such file|npm ERR|ERESOLVE|SyntaxError|Cannot find module|error:|fatal:)/i;
const ENV_MISMATCH = /(EBADENGINE|EBADDEVENGINES|requires? (a )?(python|node)|python[ _]requires|Unsupported (engine|Python)|No matching distribution|requires-python)/i;
const PLACEHOLDER = /(\/path\/to|<[^>]+>|\byour[-_ ]|YOUR_|\bfoo\b|\bxxx+\b|example\.com|my-?project)/i;
const interactive = (s) => /^\s*(npm init|npm create|npx create|yarn create|pnpm create)\b/.test(s);
const norm = (s) => s.replace(/\s+/g, " ").trim();

async function nano(readme) {
  const r = await fetch("https://api.tokenfactory.nebius.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: NANO,
      max_tokens: 4000,
      temperature: 0,
      messages: [{
        role: "user",
        content: `Extract from this README the shell commands a new Linux user copies, in order, to INSTALL the project. If the README also shows a command like <tool> --version or --help, include it last.
RULES: pick ONE install method for an end user (prefer pip/pipx/npm; NEVER list alternative methods such as both npm and yarn), not building from source or contributing. Never include a TUI, server or watcher. Every command must appear VERBATIM in the README text; never invent or modify commands, imports or code. Skip commands needing API keys, accounts, Docker, a GUI, macOS/Windows only, system packages via sudo, placeholders (anything like /path/to, <name>, your-...), and sample terminal output. Max 6 commands. Reply with ONLY a JSON array of strings; [] if the README has no copy-paste install path.

README:
${readme.slice(0, 24000)}`,
      }],
    }),
  });
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content ?? "";
  const arrays = [...text.matchAll(/\[[^\[\]]*\]/g)].map((m) => m[0]);
  let steps = [];
  for (const a of arrays.reverse()) { try { steps = JSON.parse(a); break; } catch {} }
  const rd = norm(readme);
  steps = steps.filter((s) => typeof s === "string").map((s) => s.replace(/^\s*\$\s+/, "").trim());
  const defined = new Set();
  steps = steps.filter((s) => {
    const vars = [...s.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})/g)].map((m) => m[1]);
    const assign = s.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
    const ok = rd.includes(norm(s)) && !PLACEHOLDER.test(s) && !interactive(s) && vars.every((v) => defined.has(v));
    if (ok && assign) defined.add(assign[1]);
    return ok;
  });
  return { steps, tokens: j.usage ?? {}, raw: text.slice(-300) };
}

async function census(repo) {
  const t0 = Date.now();
  const sb = await createRetry({ persistent: false, timeout: 15 * 60_000 });
  try {
    const clone = await sb.runCommand("bash", ["-c", `git clone --depth 1 https://github.com/${repo} ${DIR} && ls ${DIR} | grep -i '^readme' | head -1`]);
    if (clone.exitCode !== 0) return { repo, status: "clone_failed" };
    const file = (await clone.stdout()).trim();
    const readme = (await sb.readFileToBuffer({ path: `${DIR}/${file}` }))?.toString("utf8") ?? "";
    const { steps, tokens, raw } = await nano(readme);
    if (!steps.length) return { repo, status: "no_steps", tokens, raw };
    // sandbox PATH: a real Ubuntu login shell has ~/.local/bin and the npm global bin; mirror that
    // deterministic smoke check when the README showed only the install: tool --help, else import / npm ls
    const last = steps[steps.length - 1];
    const py = last.match(/\b(?:pip3?|pipx|python3? -m pip) install(?: --user)? ([A-Za-z][\w.-]*)\s*$/);
    const npm = last.match(/\bnpm (?:install|i)(?: -g| --global)? ([@A-Za-z][\w@./-]*)\s*$/);
    if (py && !steps.some((x) => /--(help|version)\b|-h\b|-V\b/.test(x))) steps.push(`(command -v ${py[1]} >/dev/null && ${py[1]} --help >/dev/null) || python3 -c "import ${py[1].replace(/-/g, "_")}"`);
    if (npm && !steps.some((x) => /--(help|version)\b/.test(x))) steps.push(`npm ls -g ${npm[1]} >/dev/null 2>&1 || npm ls ${npm[1]} >/dev/null`);
    const pre = 'export PATH="$HOME/.local/bin:$(npm prefix -g 2>/dev/null)/bin:$PATH"';
    const results = [];
    for (const s of steps) {
      const r = await sb.runCommand({ cmd: "bash", args: ["-lc", `${pre}; cd ${DIR}; timeout 120 bash -c ${JSON.stringify(s)} 2>&1 | tail -c 1500; exit \${PIPESTATUS[0]}`], cwd: DIR });
      const out = await r.stdout();
      // missing alternative installers (yarn/pnpm/brew/...) are skipped, timeouts are inconclusive (TUI/server), neither is a README break
      const alt = r.exitCode === 127 && /\b(yarn|pnpm|bun|brew|conda|apt|apt-get|snap|choco)\b/.test(s);
      results.push({ step: s, exit: alt ? 0 : r.exitCode, skipped: alt, masked: r.exitCode === 0 && ERR.test(out), tail: out.slice(-600) });
      if (!alt && r.exitCode !== 0) break;
    }
    const bad = results.find((x) => x.exit !== 0 || x.masked);
    const status = !bad ? "ok" : bad.exit === 124 ? "inconclusive" : ENV_MISMATCH.test(bad.tail) ? "env_mismatch" : "readme_break";
    return { repo, status, failedStep: bad?.step, steps: results, tokens };
  } catch (e) {
    return { repo, status: "error", error: String(e).slice(0, 200) };
  } finally {
    await sb.stop().catch(() => {});
  }
}

const queue = [...repos];
await Promise.all(Array.from({ length: +conc }, async () => {
  while (queue.length) {
    const repo = queue.shift();
    const t0 = Date.now();
    const res = { ...(await census(repo)) };
    res.secs = Math.round((Date.now() - t0) / 1000); // sandbox wall seconds incl. clone
    appendFileSync(outFile, JSON.stringify(res) + "\n");
    console.log(res.status.padEnd(13), String(res.secs).padStart(4) + "s", repo, res.failedStep ?? "");
  }
}));
