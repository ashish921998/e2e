import {
  PROOF_PLAN_VERSION,
  type PlanInterpretation,
  type ProofPlan,
  type ProofStep,
  type RecordedSession,
} from "./types";

const MAX_STEPS = 30;

export function validateProofPlan(value: unknown): PlanInterpretation {
  if (!isRecord(value)) return invalid("Proof plan must be an object.");
  if (value.version !== PROOF_PLAN_VERSION) return invalid("Unsupported proof plan version.");
  if (!isNonEmptyString(value.name)) return invalid("Proof plan name is required.");
  if (!isNonEmptyString(value.intent)) return invalid("Proof plan intent is required.");
  if (!isNonEmptyString(value.sourceSessionId)) return invalid("Proof plan session id is required.");
  if (!Array.isArray(value.steps) || value.steps.length === 0) return invalid("Proof plan needs at least one step.");
  if (value.steps.length > MAX_STEPS) return invalid(`Proof plan cannot exceed ${MAX_STEPS} steps.`);

  const steps: ProofStep[] = [];
  for (const [index, step] of value.steps.entries()) {
    const valid = validateStep(step, index);
    if (typeof valid === "string") return invalid(valid);
    steps.push(valid);
  }

  if (steps[0]?.kind !== "goto") return invalid("The first proof step must be goto.");

  return {
    ok: true,
    source: "model",
    plan: {
      version: PROOF_PLAN_VERSION,
      name: value.name.trim(),
      intent: value.intent.trim(),
      sourceSessionId: value.sourceSessionId.trim(),
      steps,
    },
  };
}

export function deterministicPlanFromSession(session: RecordedSession): PlanInterpretation {
  const steps: ProofStep[] = [];
  for (const event of session.events) {
    switch (event.type) {
      case "navigate":
        steps.push({ kind: "goto", path: event.path, label: event.label });
        break;
      case "click":
        if (event.role && event.accessibleName) {
          steps.push({ kind: "clickRole", role: event.role, name: event.accessibleName, label: event.label });
        }
        break;
      case "fill":
        if (event.role && event.accessibleName && event.value !== undefined) {
          steps.push({ kind: "fillRole", role: event.role, name: event.accessibleName, value: event.value, label: event.label });
        }
        break;
      case "observe":
        if (event.role && event.accessibleName) {
          steps.push({ kind: "expectRole", role: event.role, name: event.accessibleName, label: event.label });
        } else if (event.text.trim()) {
          steps.push({ kind: "expectText", text: event.text, label: event.label });
        }
        break;
      // Select is intentionally unsupported in the first renderer.
      case "select":
        break;
    }
  }

  const candidate = {
    version: PROOF_PLAN_VERSION,
    name: session.title || "Recorded proof",
    intent: `Replay the successful verification recorded in ${session.id}.`,
    sourceSessionId: session.id,
    steps,
  };
  const validated = validateProofPlan(candidate);
  return validated.ok ? { ...validated, source: "deterministic-fallback" } : validated;
}

function validateStep(value: unknown, index: number): ProofStep | string {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) return `Step ${index + 1} is invalid.`;
  const label = typeof value.label === "string" ? value.label : undefined;
  switch (value.kind) {
    case "goto":
      return isSafePath(value.path) ? { kind: "goto", path: value.path, label } : `Step ${index + 1} needs a relative path.`;
    case "clickRole":
      return strings(value, "role", "name") ? { kind: "clickRole", role: value.role.trim(), name: value.name.trim(), label } : `Step ${index + 1} needs role and name.`;
    case "fillRole":
      return strings(value, "role", "name", "value") ? { kind: "fillRole", role: value.role.trim(), name: value.name.trim(), value: value.value, label } : `Step ${index + 1} needs role, name and value.`;
    case "expectText":
      return isNonEmptyString(value.text) ? { kind: "expectText", text: value.text.trim(), label } : `Step ${index + 1} needs text.`;
    case "expectRole":
      return strings(value, "role", "name") ? { kind: "expectRole", role: value.role.trim(), name: value.name.trim(), label } : `Step ${index + 1} needs role and name.`;
    default:
      return `Step ${index + 1} uses unsupported action '${value.kind}'.`;
  }
}

function invalid(error: string): PlanInterpretation { return { ok: false, error }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isSafePath(value: unknown): value is string { return typeof value === "string" && /^\/(?!\/)/.test(value); }
function strings(value: Record<string, unknown>, ...keys: string[]): value is Record<string, string> {
  return keys.every((key) => isNonEmptyString(value[key]));
}
