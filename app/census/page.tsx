import Link from "next/link";
import data from "@/data/census-summary.json";

export const metadata = { title: "README Rot Census · README Proof" };

export default function Census() {
  const evaluated = data.samples.reduce((a, s) => a + s.repos - s.noSteps, 0);
  const breaks = data.samples.reduce((a, s) => a + s.genuineBreaks, 0);
  const older = data.samples.slice(1);
  const olderEval = older.reduce((a, s) => a + s.repos - s.noSteps, 0);
  const olderBreaks = older.reduce((a, s) => a + s.genuineBreaks, 0);
  return (
    <main>
      <header className="top">
        <div><h1>README Rot Census</h1><p className="tag">We ran the install steps of {data.samples.reduce((a, s) => a + s.repos, 0)} real GitHub CLI repos on a clean machine and sorted every failure by hand.</p></div>
        <nav><Link href="/">← Run a repo</Link></nav>
      </header>
      <div className="stat">
        <div><b>{Math.round((olderBreaks / olderEval) * 100)}%</b>of older, starred CLI repos fail their own README ({olderBreaks} of {olderEval})</div>
        <div><b>0 / 6</b>maintained popular repos failed</div>
        <div><b>{data.breaks.filter((b) => b.fixed).length} / {breaks}</b>genuine breaks with a fix verified in a second clean sandbox</div>
      </div>
      <h3>Samples</h3>
      <table><thead><tr><th>Sample</th><th>Repos</th><th>Install steps found</th><th>No steps</th><th>Genuine breaks</th></tr></thead>
        <tbody>{data.samples.map((s) => (<tr key={s.name}><td>{s.name}</td><td>{s.repos}</td><td>{s.repos - s.noSteps}</td><td>{s.noSteps}</td><td>{s.genuineBreaks}</td></tr>))}</tbody></table>
      <h3>Every genuine break and its verified fix</h3>
      <table><thead><tr><th>Repo</th><th>What broke</th><th>Fix</th><th>Cost</th></tr></thead>
        <tbody>{data.breaks.map((b) => (<tr key={b.repo}><td><a href={`https://github.com/${b.repo}`}>{b.repo}</a></td><td>{b.cause}</td><td>{b.fixed ? `verified, ${b.rounds} rounds${b.tuned ? "" : " (untuned)"}` : "no"}</td><td>${b.usd}</td></tr>))}</tbody></table>
      <h3>How to read this</h3>
      <ul>{data.notes.map((n) => <li key={n} className="muted">{n}</li>)}<li className="muted">{data.method}</li><li className="muted">Evaluated {evaluated} repos with an extractable install path, {breaks} broke.</li></ul>
    </main>
  );
}
