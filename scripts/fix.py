"""Kill test step 3: give Ultra the README, repo tree and failing sandbox log; get a README fix."""
import json, os, sys, urllib.request

run = json.load(open(sys.argv[1]))
failed = [s for s in run["steps"] if s["exitCode"] != 0]
prior = ""
if len(sys.argv) > 3:  # previous attempt + its sandbox verification log
    prior = f"""YOUR PREVIOUS FIX:
{open(sys.argv[2]).read()}

WE RAN YOUR VERIFY COMMANDS IN A CLEAN SANDBOX. RESULT:
{json.dumps(json.load(open(sys.argv[3]))['steps'], indent=1)}

That fix did not work. Use this evidence; do not repeat the same mistake.
"""
prompt = f"""A user followed this repository's README in a clean Ubuntu machine (Python 3.14, Node 24) and it failed.

REPO FILES (first 300):
{run['tree']}

README ({run['readmeFile']}):
{run['readme']}

STEPS RUN AND RESULTS:
{json.dumps(run['steps'], indent=1)}

{prior}
Facts about the verify machine: clean Ubuntu, non-root user with passwordless sudo, no Docker, internet access. You can only change the README (not source files or PyPI packages). Keep your thinking short; your final answer must start with the line `1. ROOT CAUSE:`.
Diagnose the root cause of the first failing step. Then output:
1. ROOT CAUSE: one or two sentences.
2. README PATCH: a unified diff against {run['readmeFile']} that makes the documented install/run path work for a new user today. Change only what is needed.
3. VERIFY: the exact shell commands (one per line, inside a ```bash fence) a clean machine should run to prove the patched README works."""

req = urllib.request.Request("https://api.tokenfactory.nebius.com/v1/chat/completions",
    data=json.dumps({"model": "nvidia/Nemotron-3-Ultra-550b-a55b", "max_tokens": 20000,
                     "messages": [{"role": "user", "content": prompt}]}).encode(),
    headers={"Authorization": f"Bearer {os.environ['NEBIUS_API_KEY']}", "Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=600) as r:
    d = json.load(r)
out = d["choices"][0]["message"]["content"]
print(out[out.rfind("1. ROOT CAUSE:"):] if "1. ROOT CAUSE:" in out else out)
print("\n[usage]", d.get("usage"), file=sys.stderr)
