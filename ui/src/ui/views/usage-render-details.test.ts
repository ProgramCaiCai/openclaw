import { describe, it, expect } from "vitest";
import {
  computeFilteredUsage,
  filterPointsByDateRange,
  CHART_BAR_WIDTH_RATIO,
  CHART_MAX_BAR_WIDTH,
} from "./usage-render-details.ts";
import type { SessionLogEntry, TimeSeriesPoint, UsageSessionEntry } from "./usageTypes.ts";

function makePoint(overrides: Partial<TimeSeriesPoint> = {}): TimeSeriesPoint {
  return {
    timestamp: 1000,
    totalTokens: 100,
    cost: 0.01,
    input: 30,
    output: 40,
    cacheRead: 20,
    cacheWrite: 10,
    cumulativeTokens: 0,
    cumulativeCost: 0,
    ...overrides,
  };
}

const baseUsage = {
  totalTokens: 1000,
  totalCost: 1.0,
  input: 300,
  output: 400,
  cacheRead: 200,
  cacheWrite: 100,
  durationMs: 60000,
  firstActivity: 0,
  lastActivity: 60000,
  missingCostEntries: 0,
  messageCounts: {
    total: 10,
    user: 5,
    assistant: 5,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  },
} satisfies NonNullable<UsageSessionEntry["usage"]>;

describe("computeFilteredUsage", () => {
  it("returns undefined when no points match the range", () => {
    const points = [makePoint({ timestamp: 1000 }), makePoint({ timestamp: 2000 })];
    const result = computeFilteredUsage(baseUsage, points, 3000, 4000);
    expect(result).toBeUndefined();
  });

  it("aggregates tokens and cost for points within range", () => {
    const points = [
      makePoint({ timestamp: 1000, totalTokens: 100, cost: 0.1 }),
      makePoint({ timestamp: 2000, totalTokens: 200, cost: 0.2 }),
      makePoint({ timestamp: 3000, totalTokens: 300, cost: 0.3 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 1000, 2000);
    expect(result).toBeDefined();
    expect(result!.totalTokens).toBe(300); // 100 + 200
    expect(result!.totalCost).toBeCloseTo(0.3); // 0.1 + 0.2
  });

  it("handles reversed range (end < start)", () => {
    const points = [
      makePoint({ timestamp: 1000, totalTokens: 50 }),
      makePoint({ timestamp: 2000, totalTokens: 75 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 2000, 1000);
    expect(result).toBeDefined();
    expect(result!.totalTokens).toBe(125);
  });

  it("counts message types based on input/output presence", () => {
    const points = [
      makePoint({ timestamp: 1000, input: 10, output: 0 }),
      makePoint({ timestamp: 2000, input: 0, output: 20 }),
      makePoint({ timestamp: 3000, input: 5, output: 15 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 1000, 3000);
    expect(result!.messageCounts!.user).toBe(2); // points with input > 0
    expect(result!.messageCounts!.assistant).toBe(2); // points with output > 0
    expect(result!.messageCounts!.total).toBe(3);
  });

  it("computes duration from first to last filtered point", () => {
    const points = [makePoint({ timestamp: 1000 }), makePoint({ timestamp: 5000 })];
    const result = computeFilteredUsage(baseUsage, points, 1000, 5000);
    expect(result!.durationMs).toBe(4000);
    expect(result!.firstActivity).toBe(1000);
    expect(result!.lastActivity).toBe(5000);
  });

  it("preserves non-derivable messageCounts (toolCalls, toolResults, errors) from baseUsage", () => {
    const usage = {
      ...baseUsage,
      messageCounts: { total: 10, user: 5, assistant: 5, toolCalls: 7, toolResults: 4, errors: 2 },
    };
    const points = [
      makePoint({ timestamp: 1000, input: 10, output: 20 }),
      makePoint({ timestamp: 2000, input: 5, output: 15 }),
    ];
    const result = computeFilteredUsage(usage, points, 1000, 2000);
    expect(result!.messageCounts!.toolCalls).toBe(7);
    expect(result!.messageCounts!.toolResults).toBe(4);
    expect(result!.messageCounts!.errors).toBe(2);
    // derivable counters should still be recomputed from filtered points
    expect(result!.messageCounts!.total).toBe(2);
    expect(result!.messageCounts!.user).toBe(2);
    expect(result!.messageCounts!.assistant).toBe(2);
  });

  it("derives message counts from logs when provided (avoids bucketed undercount)", () => {
    // Use realistic ms timestamps (>= 1e12) so normalizeLogTimestamp is a no-op
    const t0 = 1700000000000;
    const points = [
      makePoint({ timestamp: t0, input: 100, output: 200 }),
      makePoint({ timestamp: t0 + 1000, input: 50, output: 150 }),
    ];
    const logs: SessionLogEntry[] = [
      { timestamp: t0, role: "user", content: "msg1" },
      { timestamp: t0 + 200, role: "assistant", content: "msg2" },
      { timestamp: t0 + 500, role: "user", content: "msg3" },
      { timestamp: t0 + 800, role: "assistant", content: "msg4" },
      { timestamp: t0 + 1000, role: "tool", content: "msg5" },
    ];
    const result = computeFilteredUsage(baseUsage, points, t0, t0 + 1000, logs);
    expect(result!.messageCounts!.total).toBe(5);
    expect(result!.messageCounts!.user).toBe(2);
    expect(result!.messageCounts!.assistant).toBe(2);
  });

  it("falls back to point-based counts when logs are not provided", () => {
    const points = [
      makePoint({ timestamp: 1000, input: 10, output: 20 }),
      makePoint({ timestamp: 2000, input: 0, output: 15 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 1000, 2000);
    // Without logs, total = number of filtered points
    expect(result!.messageCounts!.total).toBe(2);
    expect(result!.messageCounts!.user).toBe(1);
    expect(result!.messageCounts!.assistant).toBe(2);
  });

  it("aggregates token types (input, output, cacheRead, cacheWrite)", () => {
    const points = [
      makePoint({ timestamp: 1000, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }),
      makePoint({ timestamp: 2000, input: 5, output: 15, cacheRead: 25, cacheWrite: 35 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 1000, 2000);
    expect(result!.input).toBe(15);
    expect(result!.output).toBe(35);
    expect(result!.cacheRead).toBe(55);
    expect(result!.cacheWrite).toBe(75);
  });
});

describe("chart bar sizing", () => {
  it("bar width ratio and max are reasonable", () => {
    expect(CHART_BAR_WIDTH_RATIO).toBeGreaterThan(0);
    expect(CHART_BAR_WIDTH_RATIO).toBeLessThan(1);
    expect(CHART_MAX_BAR_WIDTH).toBeGreaterThan(0);
  });

  it("bars fit within chart width for typical point counts", () => {
    const chartWidth = 366; // typical: 400 - padding.left(30) - padding.right(4)
    // For reasonable point counts (up to ~300), bars should fit
    for (const n of [1, 2, 10, 50, 100, 200]) {
      const slotWidth = chartWidth / n;
      const barWidth = Math.min(
        CHART_MAX_BAR_WIDTH,
        Math.max(1, slotWidth * CHART_BAR_WIDTH_RATIO),
      );
      const barGap = slotWidth - barWidth;
      // Slot-based sizing guarantees total = n * slotWidth = chartWidth
      expect(n * slotWidth).toBeCloseTo(chartWidth);
      // Bar gap is non-negative when slotWidth >= 1 / CHART_BAR_WIDTH_RATIO
      if (slotWidth >= 1 / CHART_BAR_WIDTH_RATIO) {
        expect(barGap).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("filterPointsByDateRange", () => {
  it("returns all points when no filters are provided", () => {
    const points = [makePoint({ timestamp: 1000 }), makePoint({ timestamp: 2000 })];
    expect(filterPointsByDateRange(points)).toEqual(points);
  });

  it("filters by startDate and endDate", () => {
    const t1 = new Date("2024-01-15T12:00:00").getTime();
    const t2 = new Date("2024-01-16T12:00:00").getTime();
    const t3 = new Date("2024-01-17T12:00:00").getTime();
    const points = [
      makePoint({ timestamp: t1 }),
      makePoint({ timestamp: t2 }),
      makePoint({ timestamp: t3 }),
    ];
    const result = filterPointsByDateRange(points, "2024-01-15", "2024-01-16");
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.timestamp)).toEqual([t1, t2]);
  });

  it("filters by selectedDays excluding non-contiguous days", () => {
    const t1 = new Date("2024-01-15T10:00:00").getTime();
    const t2 = new Date("2024-01-16T10:00:00").getTime();
    const t3 = new Date("2024-01-17T10:00:00").getTime();
    const points = [
      makePoint({ timestamp: t1 }),
      makePoint({ timestamp: t2 }),
      makePoint({ timestamp: t3 }),
    ];
    const result = filterPointsByDateRange(points, undefined, undefined, [
      "2024-01-15",
      "2024-01-17",
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.timestamp)).toEqual([t1, t3]);
  });

  it("computeFilteredUsage with day-filtered points excludes hidden points", () => {
    const t1 = new Date("2024-01-15T10:00:00").getTime();
    const t2 = new Date("2024-01-16T10:00:00").getTime();
    const t3 = new Date("2024-01-17T10:00:00").getTime();
    const points = [
      makePoint({ timestamp: t1, totalTokens: 100, cost: 0.1 }),
      makePoint({ timestamp: t2, totalTokens: 200, cost: 0.2 }),
      makePoint({ timestamp: t3, totalTokens: 300, cost: 0.3 }),
    ];
    const visible = filterPointsByDateRange(points, undefined, undefined, [
      "2024-01-15",
      "2024-01-17",
    ]);
    const result = computeFilteredUsage(baseUsage, visible, t1, t3);
    expect(result).toBeDefined();
    expect(result!.totalTokens).toBe(400);
    expect(result!.totalCost).toBeCloseTo(0.4);
  });

  it("computeFilteredUsage log counts follow selected non-contiguous days", () => {
    const t1 = new Date("2024-01-15T10:00:00").getTime();
    const t2 = new Date("2024-01-16T10:00:00").getTime();
    const t3 = new Date("2024-01-17T10:00:00").getTime();
    const points = [
      makePoint({ timestamp: t1, totalTokens: 100 }),
      makePoint({ timestamp: t2, totalTokens: 200 }),
      makePoint({ timestamp: t3, totalTokens: 300 }),
    ];
    const selectedDays = ["2024-01-15", "2024-01-17"];
    const visible = filterPointsByDateRange(points, undefined, undefined, selectedDays);
    const logs: SessionLogEntry[] = [
      { timestamp: t1, role: "user", content: "day1" },
      { timestamp: t2, role: "assistant", content: "day2-hidden" },
      { timestamp: t3, role: "user", content: "day3" },
    ];

    const result = computeFilteredUsage(baseUsage, visible, t1, t3, logs, selectedDays);
    expect(result).toBeDefined();
    expect(result!.messageCounts!.total).toBe(2);
    expect(result!.messageCounts!.user).toBe(2);
    expect(result!.messageCounts!.assistant).toBe(0);
  });
});
