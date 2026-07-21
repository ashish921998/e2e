import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordedBrowserEvent, RecordedSession } from "../../proof/types";

export const CAPTURE_SESSION_STORAGE_PREFIX = "proofmode:captured-session:";

function now() {
  return new Date().toISOString();
}

function makeSessionId() {
  return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function eventDescription(event: RecordedBrowserEvent) {
  if (event.type === "navigate") return `Opened ${event.path}`;
  if (event.type === "observe") return `Observed ${event.role ?? "content"}: ${event.text}`;
  return `${event.type === "click" ? "Clicked" : event.type} ${event.accessibleName ?? event.text ?? "control"}`;
}

function accessibleName(element: Element) {
  return element.getAttribute("aria-label") ?? element.textContent?.trim() ?? undefined;
}

function semanticRole(element: Element) {
  return element.getAttribute("role") ?? (element instanceof HTMLButtonElement ? "button" : undefined);
}

export function loadCapturedSession(sessionId: string): RecordedSession | null {
  try {
    const raw = window.localStorage.getItem(`${CAPTURE_SESSION_STORAGE_PREFIX}${sessionId}`);
    return raw ? (JSON.parse(raw) as RecordedSession) : null;
  } catch {
    return null;
  }
}

export function SessionCapture() {
  const [session, setSession] = useState<RecordedSession | null>(null);
  const sessionRef = useRef<RecordedSession | null>(null);

  const persist = useCallback((next: RecordedSession) => {
    sessionRef.current = next;
    setSession(next);
    window.localStorage.setItem(`${CAPTURE_SESSION_STORAGE_PREFIX}${next.id}`, JSON.stringify(next));
  }, []);

  const record = useCallback((event: RecordedBrowserEvent) => {
    const active = sessionRef.current;
    if (!active || active.completedAt) return;
    persist({ ...active, events: [...active.events, event] });
  }, [persist]);

  useEffect(() => {
    const onPopState = () => record({ type: "navigate", at: now(), path: `${window.location.pathname}${window.location.search}`, label: "Navigate in the live product" });
    const onClick = (nativeEvent: MouseEvent) => {
      const element = (nativeEvent.target as Element | null)?.closest("button, a, input, select");
      if (!element) return;
      // Do not record interactions with the recorder's own chrome — the
      // generated test must drive the product, not e2e's capture panel.
      if (element.closest(".capture-panel")) return;
      record({ type: "click", at: now(), role: semanticRole(element), accessibleName: accessibleName(element), label: "Live browser interaction" });
    };
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onClick);
    };
  }, [record]);

  const observeLiveProduct = useCallback(() => {
    const heading = document.querySelector("h1");
    const status = document.querySelector('[role="status"]');
    if (heading?.textContent?.trim()) {
      record({ type: "observe", at: now(), role: "heading", accessibleName: heading.textContent.trim(), text: heading.textContent.trim(), label: "Confirm the product loaded" });
    }
    if (status?.textContent?.trim()) {
      // `status` is a live region, not an accessible-name-bearing control.
      // Preserve its visible text so the deterministic renderer emits expectText.
      record({ type: "observe", at: now(), role: "status", text: status.textContent.trim(), label: "Confirm the live product status" });
    }
  }, [record]);

  const start = useCallback(() => {
    const startedAt = now();
    const next: RecordedSession = {
      id: makeSessionId(),
      title: "Live product verification",
      startedAt,
      targetId: "local",
      events: [{ type: "navigate", at: startedAt, path: `${window.location.pathname}${window.location.search}`, label: "Open the live product" }],
    };
    persist(next);
    // Capture semantic evidence from the actual rendered page, not a fixture.
    requestAnimationFrame(observeLiveProduct);
  }, [observeLiveProduct, persist]);

  const stop = useCallback(() => {
    const active = sessionRef.current;
    if (!active || active.completedAt) return;
    observeLiveProduct();
    // Observation is queued through state; write the completed timestamp against the current event set.
    requestAnimationFrame(() => {
      const latest = sessionRef.current;
      if (latest && !latest.completedAt) persist({ ...latest, completedAt: now() });
    });
  }, [observeLiveProduct, persist]);

  const active = Boolean(session && !session.completedAt);
  const proofHref = session?.completedAt ? `/proof?session=${encodeURIComponent(session.id)}&target=local` : undefined;
  const duration = useMemo(() => session?.completedAt ? `${((new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()) / 1000).toFixed(1)}s captured` : active ? "Recording live" : "Ready to capture", [active, session]);

  return (
    <aside className="capture-panel" aria-label="e2e session capture">
      <div className="capture-heading">
        <div><p className="capture-kicker">e2e recorder</p><h2>Capture the evidence</h2></div>
        <span className={active ? "capture-live" : "capture-state"}>{duration}</span>
      </div>
      <p className="capture-copy">Records live navigation, product semantics, and browser interactions. The session stays on this device until you create a proof.</p>
      <div className="capture-controls">
        {!active ? <button className="capture-button" type="button" onClick={start}>{session?.completedAt ? "New recording" : "Start recording"}</button> : <button className="capture-button stop" type="button" onClick={stop}>Stop &amp; save</button>}
        {proofHref ? <a className="capture-proof-link" href={proofHref}>Create proof <span aria-hidden="true">↗</span></a> : null}
      </div>
      {session ? <ol className="capture-events" aria-label="Captured event timeline">
        {session.events.map((event, index) => <li key={`${event.at}-${index}`}><span>{new Date(event.at).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}</span><p>{eventDescription(event)}</p></li>)}
      </ol> : <p className="capture-empty">Start a recording, then inspect the live product. We will collect the page’s accessible heading and status as evidence.</p>}
    </aside>
  );
}
