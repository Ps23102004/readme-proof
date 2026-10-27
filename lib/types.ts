// Events streamed from the pipeline to the UI, one JSON object per line (NDJSON). Live runs and replays share this shape.
export type StepStatus = "pending" | "running" | "green" | "red" | "skipped";

export type Ev =
  | { type: "start"; repo: string; replay?: boolean }
  | { type: "log"; msg: string }
  | { type: "readme"; file: string; bytes: number }
  | { type: "steps"; steps: string[]; nanoTokens: number }
  | { type: "step"; i: number; status: StepStatus; exit?: number; tail?: string }
  | { type: "verdict"; status: "ok" | "broken" | "env_mismatch" | "no_steps" | "inconclusive"; failedStep?: string }
  | { type: "tavily"; query: string; results: { title: string; url: string; snippet: string }[] }
  | { type: "tavily_skipped"; reason: string }
  | { type: "round"; n: number; phase: "thinking" | "answer" | "verifying" | "red" | "green"; rootCause?: string; patch?: string; cmds?: string[]; log?: string; usd?: number; tokens?: number }
  | { type: "result"; fixed: boolean; rounds: number; usd: number; tokens: number; patch?: string; cmds?: string[] }
  | { type: "error"; msg: string };

export const DEMOS = [
  { id: "readme-md-generator", repo: "kefranabg/readme-md-generator", blurb: "npx command name is not the package name" },
  { id: "archivy", repo: "archivy/archivy", blurb: "installs, then crashes: pkg_resources is gone" },
] as const;
