import type { ProofTarget } from "./types";

export type TargetRegistry = Readonly<Record<string, ProofTarget>>;

export function defineTargets(targets: readonly ProofTarget[]): TargetRegistry {
  const registry: Record<string, ProofTarget> = {};

  for (const target of targets) {
    if (!target.id.trim()) throw new Error("Proof target id cannot be empty.");
    if (registry[target.id]) throw new Error(`Duplicate proof target: ${target.id}`);
    const baseUrl = normaliseBaseUrl(target.baseUrl);
    registry[target.id] = { ...target, baseUrl };
  }

  return Object.freeze(registry);
}

export function getTarget(registry: TargetRegistry, targetId: string): ProofTarget {
  const target = registry[targetId];
  if (!target) throw new Error(`Unknown proof target: ${targetId}`);
  return target;
}

export function normaliseBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Proof targets must use http or https.");
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveTargetUrl(target: ProofTarget, path: string): string {
  if (!path.startsWith("/")) throw new Error(`Proof paths must start with '/': ${path}`);
  return `${target.baseUrl}${path}`;
}
