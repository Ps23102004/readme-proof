"""Kill test step 1: list Nemotron models on Token Factory, smoke-call each, probe Ultra context limit."""
import json, os, sys, time, urllib.request, urllib.error

BASE = "https://api.tokenfactory.nebius.com/v1"
KEY = os.environ.get("NEBIUS_API_KEY") or sys.exit("set NEBIUS_API_KEY")

def call(path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:300]}

models = [m["id"] for m in call("/models").get("data", [])]
nv = [m for m in models if "nemotron" in m.lower() or "nvidia" in m.lower()]
print("nvidia models:", *nv, sep="\n  ")

for m in nv:
    t = time.time()
    r = call("/chat/completions", {"model": m, "max_tokens": 40,
        "messages": [{"role": "user", "content": "Reply with the single word: ready"}]})
    out = r["choices"][0]["message"]["content"] if "choices" in r else r
    print(f"{m}: {time.time()-t:.1f}s -> {str(out)[:80]!r}")

ultra = next((m for m in nv if "ultra" in m.lower()), None)
if ultra:
    for kt in (100, 300, 900):  # ~tokens in thousands; word "alpha " ~1 token
        filler = "alpha " * (kt * 1000)
        r = call("/chat/completions", {"model": ultra, "max_tokens": 10,
            "messages": [{"role": "user", "content": filler + "\nReply: ok"}]})
        print(f"ultra ctx probe ~{kt}K tokens:", "OK" if "choices" in r else r)
        if "choices" not in r: break
