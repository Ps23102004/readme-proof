# README Proof

**Your README has never been run by a stranger. README Proof runs it on a clean machine, and if it breaks, an AI fix only counts once a second clean machine proves it.**

Paste a GitHub URL. README Proof:

1. **Census.** NVIDIA Nemotron 3 Nano reads the README and extracts the install path (every command must appear verbatim in the README). A fresh [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) (Ubuntu, Python 3.14, Node 24) runs it step by step: green or red.
2. **Upstream check.** When a step fails, [Tavily](https://tavily.com) searches for the release notes or breaking change behind it.
3. **Fix loop.** NVIDIA Nemotron 3 Ultra gets the README, the repo tree, the failing log and the Tavily evidence, and returns a root cause, a README diff and the exact commands that should now work. A *second* fresh sandbox runs those commands. If they fail, the real log and real package-index lookups (`pip index versions`, `apt-cache policy`) go back to Ultra, up to 4 rounds. A fix is reported only when the sandbox goes green.

## Why

One-shot AI fixes for install docs are confidently wrong. In our tests Ultra's first answer fixed **0 of 2** broken READMEs. With the sandbox in the loop it fixed **2 of 2**, then **7 of 7** genuine breaks found by the census.

## README Rot Census (2026-10-27)

We ran 70 real GitHub CLI repos and sorted every failure by hand (see `/census` in the app and `data/`):

| Sample | Repos | Install path found | Genuine breaks |
|---|---|---|---|
| Maintained, popular | 10 | 6 | 0 |
| Older but starred, batch 1 | 30 | 24 | 5 |
| Older but starred, batch 2 | 30 | 24 | 2 |

About **15%** (7 of 48) of older, starred CLI repos fail their own README on a clean machine. All 7 now have a sandbox-verified fix, at about $0.01–0.04 of Ultra tokens per round. Caveats: 5 of the 7 were found on repos the loop was tuned on; only 2 are an untuned result. Sandbox environment limits (no sound card, no `pipx`) are not counted as README breaks.

## How NVIDIA Nemotron and Nebius Token Factory are used

| Model (Token Factory) | Job |
|---|---|
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | Fast, cheap README reading: extract the install path as JSON (~4K tokens per repo) |
| `nvidia/Nemotron-3-Ultra-550b-a55b` | Root cause, README diff and verify commands; reasons over the README, repo tree, failure log, Tavily evidence and earlier failed attempts (verified with prompts up to ~300K tokens) |

All inference goes through Nebius Token Factory's OpenAI-compatible API (`lib/models.ts`). Nano handles every repo; Ultra is only called when something is broken, which keeps a census run cheap.

## Run it

```bash
git clone https://github.com/Ps23102004/readme-proof
cd readme-proof
npm install
vercel link && vercel env pull .env.local   # Vercel Sandbox auth (OIDC token)
echo "NEBIUS_API_KEY=..." >> .env.local       # Nebius Token Factory key
echo "TAVILY_API_KEY=..." >> .env.local       # optional, enables the upstream check
npm run dev
```

Open http://localhost:3000, paste a GitHub URL, or click a recorded run.

Environment variables: `NEBIUS_API_KEY` (required), `TAVILY_API_KEY` (optional), `LIVE_ENABLED=false` to allow only recorded runs, `LIVE_DAILY_CAP` (default 40).

The batch scripts used for the census are in `scripts/` (`census.mjs`, `loop.mjs`).

## Limits

- A Vercel Function can run for 300 s; a live run that needs several Ultra rounds can exceed it. The recorded runs are real runs captured from this app.
- The sandbox is Ubuntu with no GPU, audio or Docker; READMEs that need those are reported, not "fixed".
- Fixes are README changes only. README Proof never edits source code or opens PRs on its own.

## License

MIT
