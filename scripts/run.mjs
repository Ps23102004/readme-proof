// Kill test step 2: clone a repo into a Vercel Sandbox, run its README shell steps, print a JSON log.
// Usage: node --env-file=.env.local run.mjs <git-url> [image]
import { Sandbox } from "@vercel/sandbox";

const [url, image = "vercel/sandbox/universal"] = process.argv.slice(2);
if (!url) throw new Error("usage: run.mjs <git-url> [image]");

const sandbox = await Sandbox.create({
  image,
  persistent: false,
  timeout: 10 * 60_000,
});
const DIR = "/tmp/repo";
try {
  const clone = await sandbox.runCommand("bash", ["-c", `git clone --depth 1 ${JSON.stringify(url)} ${DIR} && ls ${DIR} | grep -i '^readme' | head -1`]);
  if (clone.exitCode !== 0) throw new Error(await clone.stderr());
  const name = (await clone.stdout()).trim();
  const readme = (await sandbox.readFileToBuffer({ path: `${DIR}/${name}` }))?.toString("utf8") ?? "";

  // Shell-tagged fences: every line is a step. Untagged fences: only `$ `-prompted lines.
  // STEPS env (newline-separated) overrides parsing until the Nano block classifier exists.
  const steps = process.env.STEPS ? process.env.STEPS.split("\n") : [...readme.matchAll(/```[ \t]*(\w*)[^\n]*\n([\s\S]*?)```/g)].flatMap(([, lang, body]) => {
    const shell = /^(bash|sh|shell|console|zsh)$/i.test(lang);
    if (lang && !shell) return [];
    return body.split("\n")
      .filter((l) => shell || /^\s*\$ /.test(l))
      .map((l) => l.replace(/^\s*\$\s*/, "").trim())
      .filter((l) => l && !l.startsWith("#"));
  });

  const results = [];
  for (const step of steps) {
    // ponytail: one shell per step, so `cd` / exports don't carry over; join steps if READMEs need that
    const r = await sandbox.runCommand({ cmd: "bash", args: ["-lc", step], cwd: DIR });
    const out = (await r.stdout()) + (await r.stderr());
    results.push({ step, exitCode: r.exitCode, tail: out.slice(-2000) });
  }
  const tree = await sandbox.runCommand("bash", ["-c", `cd ${DIR} && git ls-files | head -300`]);
  console.log(JSON.stringify({ repo: url, readmeFile: name, readme, tree: await tree.stdout(), steps: results }, null, 1));
} finally {
  await sandbox.stop();
}
