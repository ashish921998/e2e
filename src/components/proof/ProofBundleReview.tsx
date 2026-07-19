import type { ReactNode } from "react";
import type { ProofBundle, ProofScreenshot, ProofStep, ProofVerdict } from "./types";
import "./proof-bundle.css";

export interface ProofBundleReviewProps {
  bundle: ProofBundle;
  className?: string;
}

const verdictLabels: Record<ProofVerdict, string> = {
  passed: "Verified",
  failed: "Assertion failed",
  compile_error: "Could not compile",
  runner_error: "Runner interrupted",
  running: "Verifying",
  incomplete: "Not yet replayed",
};

const stepIcons: Record<ProofStep["status"], string> = {
  passed: "✓",
  failed: "×",
  skipped: "–",
  running: "·",
};

function formatDuration(durationMs?: number) {
  if (durationMs === undefined) return "Not recorded";
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function formatTime(value?: string) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function Card({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return <section className="proof-card"><div className="proof-card__heading"><h2 className="proof-card__title">{title}</h2>{meta && <span className="proof-card__meta">{meta}</span>}</div>{children}</section>;
}

function StepList({ steps }: { steps: ProofStep[] }) {
  if (!steps.length) return <p className="proof-empty">No structured execution steps were captured.</p>;
  return <ol className="proof-steps">{steps.map((step) => <li className={`proof-step proof-step--${step.status}`} key={step.id}>
    <span className="proof-step__icon" aria-label={step.status}>{stepIcons[step.status]}</span>
    <div className="proof-step__content"><div className="proof-step__label">{step.label}</div>{step.detail && <div className="proof-step__detail">{step.detail}</div>}{step.timestamp && <div className="proof-step__time">{step.timestamp}</div>}</div>
  </li>)}</ol>;
}

function Screenshots({ screenshots }: { screenshots: ProofScreenshot[] }) {
  if (!screenshots.length) return <p className="proof-empty">No screenshots captured for this run.</p>;
  return <div className="proof-screens">{screenshots.map((shot) => <a className="proof-shot" href={shot.src} key={shot.id} target="_blank" rel="noreferrer"><img src={shot.src} alt={shot.label} /><span>{shot.label}{shot.timestamp ? ` · ${shot.timestamp}` : ""}</span></a>)}</div>;
}

/** A self-contained, read-only reviewer surface for a reproducible agent proof. */
export function ProofBundleReview({ bundle, className = "" }: ProofBundleReviewProps) {
  const hasFailure = bundle.verdict === "failed" || bundle.verdict === "compile_error" || bundle.verdict === "runner_error";
  const classNames = ["proof-bundle", `is-${bundle.verdict}`, className].filter(Boolean).join(" ");

  return <article className={classNames} aria-label={`Proof bundle: ${bundle.title}`}>
    <header className="proof-bundle__header">
      <div><p className="proof-bundle__eyebrow">Independent replay</p><h1 className="proof-bundle__title">{bundle.title}</h1><p className="proof-bundle__run-id">Proof run · {bundle.id}</p></div>
      <div className="proof-bundle__status">
        <span className={`proof-bundle__pill is-${bundle.verdict}`}>{verdictLabels[bundle.verdict]}</span>
        {bundle.interpretedBy ? <span className="proof-bundle__pill is-interpreter">Plan interpreted by {bundle.interpretedBy}</span> : null}
        <span className="proof-bundle__target">Target: <strong>{bundle.target.name}</strong>{bundle.target.baseUrl ? ` · ${bundle.target.baseUrl}` : ""}</span>
      </div>
    </header>

    <dl className="proof-bundle__metrics"><div className="proof-bundle__metric"><dt>Replay duration</dt><dd>{formatDuration(bundle.durationMs)}</dd></div><div className="proof-bundle__metric"><dt>Started</dt><dd>{formatTime(bundle.startedAt)}</dd></div><div className="proof-bundle__metric"><dt>Revision</dt><dd>{bundle.target.revision || "Unpinned target"}</dd></div></dl>

    {hasFailure && <div className="proof-bundle__failure" role="alert"><strong>{verdictLabels[bundle.verdict]}</strong><p>{bundle.failure?.message || "This proof did not complete independently. Inspect the evidence below before trusting the change."}{bundle.failure?.location ? ` (${bundle.failure.location})` : ""}</p></div>}

    <div className="proof-bundle__grid"><main className="proof-bundle__main">
      <Card title="Replay video" meta={bundle.video?.label || "Browser evidence"}>{bundle.video ? <video className="proof-video" controls preload="metadata" poster={bundle.video.poster}><source src={bundle.video.src} />Your browser cannot play this replay video.</video> : <p className="proof-empty">No video was produced for this proof run.</p>}</Card>
      <Card title="Generated test" meta={bundle.generatedTest?.filename || "No test generated"}><pre className="proof-code"><code>{bundle.generatedTest?.source || "// A generated test was not available for this run."}</code></pre></Card>
      <Card title="Implementation diff" meta="Read-only"><pre className="proof-code"><code>{bundle.diff || "No implementation diff was attached."}</code></pre></Card>
      <Card title="Terminal transcript" meta="Redacted"><pre className="proof-terminal">{bundle.terminal || "No terminal commands were captured."}</pre></Card>
    </main>
    <aside className="proof-bundle__side">
      <Card title="Replay steps" meta={`${bundle.steps.length} captured`}><StepList steps={bundle.steps} /></Card>
      <Card title="Screenshots" meta={bundle.screenshots?.length ? `${bundle.screenshots.length} captured` : undefined}><Screenshots screenshots={bundle.screenshots || []} /></Card>
      <Card title="Artifacts">{bundle.trace ? <p className="proof-empty"><a className="proof-link" href={bundle.trace.href} target="_blank" rel="noreferrer">Download {bundle.trace.label} ↗</a></p> : <p className="proof-empty">No trace artifact is available.</p>}</Card>
    </aside></div>
    <footer className="proof-bundle__footer"><span>{bundle.verdict === "incomplete" ? "No replay has been run yet — the generated test is a preview, not a verdict." : "Verdict is based on a fresh executable replay."}</span><span>{bundle.verdict === "passed" ? "Evidence complete" : bundle.verdict === "incomplete" ? "Awaiting replay" : "Review required"}</span></footer>
  </article>;
}
