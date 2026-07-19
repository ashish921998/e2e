import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProofBundleReview } from "./components/proof";
import { loadCapturedSession, SessionCapture } from "./components/capture";
import { demoProduct, demoVariant, hasLowStockWarning } from "./demo-product";
import { makeDemoReviewBundle, makeReviewBundleFromSession } from "./proof/demo-bundle";
import { toReviewBundle, type RuntimeProofBundle } from "./proof/runtime";
import "./styles.css";

function ProductPage() {
  return (
    <main className="storefront" data-demo-variant={demoVariant}>
      <nav aria-label="Primary navigation" className="navigation">
        <a className="wordmark" href="/" aria-label="Paper and Glass home">
          Paper &amp; Glass
        </a>
        <span className="nav-label">Curated objects <a href="/proof">Open proof ↗</a></span>
      </nav>

      <section className="product" aria-labelledby="product-name">
        <div className="product-art" aria-hidden="true">
          <div className="camera-body"><span /></div>
        </div>
        <div className="product-details">
          <p className="eyebrow">Field collection / 1968</p>
          <h1 id="product-name">{demoProduct.name}</h1>
          <p className="description">A beautifully weathered 35mm companion, restored and ready for its next roll.</p>
          <p className="price" aria-label={`Price ${demoProduct.price}`}>{demoProduct.price}</p>
          {hasLowStockWarning ? (
            <p className="low-stock" role="status" aria-live="polite">
              Only {demoProduct.stockRemaining} left
            </p>
          ) : null}
          <button type="button" className="add-to-bag" aria-label={`Add ${demoProduct.name} to bag`}>
            Add to bag
          </button>
          <p className="shipping">Complimentary insured shipping within the continental US.</p>
        </div>
      </section>
      <SessionCapture />
    </main>
  );
}

function ProofPage() {
  const params = new URLSearchParams(window.location.search);
  const targetId = params.get("target") === "production" ? "production" : "local";
  const sessionId = params.get("session");
  const session = sessionId ? loadCapturedSession(sessionId) : null;
  const initialBundle = session ? makeReviewBundleFromSession(session, targetId) : makeDemoReviewBundle(targetId);
  const [bundle, setBundle] = useState(initialBundle);
  const [running, setRunning] = useState(false);
  const [useModel, setUseModel] = useState(true);
  const [runError, setRunError] = useState<string | null>(null);

  const runLiveProof = async () => {
    if (!session) return;
    setRunning(true);
    setRunError(null);
    try {
      const response = await fetch("/api/proof-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, targetId, preferModel: useModel }),
      });
      const payload = await response.json() as RuntimeProofBundle & { error?: string; detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? payload.error ?? "Proof runner request failed.");
      setBundle(toReviewBundle(payload));
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Proof runner request failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="proof-shell">
      <nav aria-label="ProofMode navigation" className="proof-nav">
        <a className="proof-brand" href="/">ProofMode</a>
        <span>Agent work, independently replayed.</span>
      </nav>
      <section className="proof-intro">
        <div>
          <p className="proof-kicker">Proof run / {targetId === "local" ? "updated branch" : "previous release"}</p>
          <h1>The agent said it worked.<br />We replayed it.</h1>
          <p>{session ? "This bundle was compiled from the session captured on this device. Run a fresh replay to produce the verdict — until then, the generated test below is a preview, not proof." : "Codex implemented a low-stock warning. The captured browser session is translated into a constrained proof plan — optionally by GPT-5.6 — and replayed in a fresh browser. The executable replay is the verdict."}</p>
        </div>
        <div className="proof-actions">
          <a className={targetId === "local" ? "active" : ""} href={`/proof?target=local${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}`}>Run local proof</a>
          <a className={targetId === "production" ? "active fail" : ""} href={`/proof?target=production${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}`}>Run older target</a>
        </div>
      </section>
      {session ? <section className="live-runner" aria-label="Live proof runner">
        <div><p className="proof-kicker">Captured session ready</p><strong>{session.events.length} browser events · {session.id}</strong><span>The runner will create a test, launch a fresh browser, and persist the evidence locally.</span></div>
        <div className="live-runner__actions">
          <label><input type="checkbox" checked={useModel} onChange={(event) => setUseModel(event.target.checked)} /> Interpret with GPT-5.6</label>
          <button type="button" onClick={() => void runLiveProof()} disabled={running}>{running ? "Replaying proof…" : "Run fresh replay"}</button>
        </div>
      </section> : <section className="live-runner is-empty"><span>Capture a live product session first to run a new proof.</span><a href="/">Open recorder ↗</a></section>}
      {runError ? <p className="runner-error" role="alert">{runError}</p> : null}
      <ProofBundleReview bundle={bundle} />
    </main>
  );
}

const isProofPage = window.location.pathname === "/proof";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isProofPage ? <ProofPage /> : <ProductPage />}</StrictMode>,
);
