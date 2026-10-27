"""Kill test step 2: clone a repo, run its README shell blocks in a throwaway container, emit a JSON log."""
import json, re, subprocess, sys, tempfile, pathlib

repo, image = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "node:22")
work = pathlib.Path(tempfile.mkdtemp(prefix="rp-"))
subprocess.run(["git", "clone", "--depth", "1", repo, str(work / "r")], check=True, capture_output=True)
readme = next((work / "r").glob("README*")).read_text()
blocks = [b.strip() for b in re.findall(r"```(?:bash|sh|shell|console)\n(.*?)```", readme, re.S)]
steps = [l.lstrip("$ ").strip() for b in blocks for l in b.splitlines()
         if l.strip() and not l.lstrip().startswith("#")]
script = "set +e\n" + "\n".join(f'echo "### STEP: {s!r}"; {s}; echo "### EXIT: $?"' for s in steps)
res = subprocess.run(["docker", "run", "--rm", "-v", f"{work/'r'}:/app", "-w", "/app", image, "bash", "-c", script],
                     capture_output=True, text=True, timeout=600)
print(json.dumps({"repo": repo, "steps": steps, "log": (res.stdout + res.stderr)[-12000:]}, indent=1))
