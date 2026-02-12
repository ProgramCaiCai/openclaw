export type CompactionSafeguardRuntimeValue = {
  maxHistoryShare?: number;
  contextWindowTokens?: number;
};

// Session-scoped runtime registry keyed by object identity.
// Follows the same WeakMap pattern as context-pruning/runtime.ts.
const REGISTRY = new WeakMap<object, CompactionSafeguardRuntimeValue>();

function clampMaxHistoryShare(value: number): number {
  return Math.max(0.1, Math.min(0.9, value));
}

export function setCompactionSafeguardRuntime(
  sessionManager: unknown,
  value: CompactionSafeguardRuntimeValue | null,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }

  const key = sessionManager;
  if (value === null) {
    REGISTRY.delete(key);
    return;
  }

  const next: CompactionSafeguardRuntimeValue = { ...value };
  if (typeof next.maxHistoryShare === "number" && Number.isFinite(next.maxHistoryShare)) {
    next.maxHistoryShare = clampMaxHistoryShare(next.maxHistoryShare);
  }

  REGISTRY.set(key, next);
}

export function getCompactionSafeguardRuntime(
  sessionManager: unknown,
): CompactionSafeguardRuntimeValue | null {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }

  return REGISTRY.get(sessionManager) ?? null;
}
