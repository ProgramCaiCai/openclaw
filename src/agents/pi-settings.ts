import type { OpenClawConfig } from "../config/config.js";

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

type PiSettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  applyOverrides: (overrides: { compaction: { reserveTokens: number } }) => void;
};

export function ensurePiCompactionReserveTokens(params: {
  settingsManager: PiSettingsManagerLike;
  minReserveTokens?: number;
}): { didOverride: boolean; reserveTokens: number } {
  const minReserveTokens = params.minReserveTokens ?? DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
  const current = params.settingsManager.getCompactionReserveTokens();

  if (current >= minReserveTokens) {
    return { didOverride: false, reserveTokens: current };
  }

  params.settingsManager.applyOverrides({
    compaction: { reserveTokens: minReserveTokens },
  });

  return { didOverride: true, reserveTokens: minReserveTokens };
}

export function resolveCompactionReserveTokensFloor(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.compaction?.reserveTokensFloor;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
}

const AUTO_COMPACT_DEFAULT_THRESHOLD_PCT = 70;
const AUTO_COMPACT_DEFAULT_MIN_TURNS = 10;

export function resolveAutoCompactConfig(cfg?: OpenClawConfig): {
  enabled: boolean;
  thresholdPct: number;
  minTurns: number;
} {
  const ac = cfg?.agents?.defaults?.compaction?.autoCompact;
  const enabled = ac?.enabled === true;
  const rawPct = ac?.thresholdPct;
  const thresholdPct =
    typeof rawPct === "number" && Number.isFinite(rawPct) && rawPct >= 50 && rawPct <= 95
      ? Math.floor(rawPct)
      : AUTO_COMPACT_DEFAULT_THRESHOLD_PCT;
  const rawTurns = ac?.minTurns;
  const minTurns =
    typeof rawTurns === "number" && Number.isFinite(rawTurns) && rawTurns >= 0
      ? Math.floor(rawTurns)
      : AUTO_COMPACT_DEFAULT_MIN_TURNS;
  return { enabled, thresholdPct, minTurns };
}
