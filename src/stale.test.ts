import { describe, expect, it } from "vitest";
import type { Feature, FeatureState } from "./flagsmith.js";
import { findStaleFlags, formatStale, formatStaleMarkdown } from "./stale.js";

const now = new Date("2026-12-31T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

const feature = (id: number, name: string, tags: number[] = []): Feature => ({ id, name, is_archived: false, tags });
const state = (feature: number, enabled: boolean, updatedDaysAgo: number, value: FeatureState["feature_state_value"] = null): FeatureState => ({
  id: feature * 100,
  feature,
  enabled,
  feature_state_value: value,
  identity: null,
  feature_segment: null,
  updated_at: daysAgo(updatedDaysAgo),
});

const features = [
  feature(1, "dark_mode"), // on everywhere, old -> stale
  feature(2, "legacy_payments"), // off everywhere, old -> stale
  feature(3, "checkout_v2"), // differs between environments -> not stale
  feature(4, "new_banner"), // same everywhere but changed recently -> not stale
  feature(5, "maintenance_mode", [7]), // off everywhere, old, but tagged permanent -> not stale
];

const states = new Map<string, FeatureState[]>([
  ["Development", [state(1, true, 90), state(2, false, 200), state(3, true, 90), state(4, true, 5), state(5, false, 300)]],
  ["Production", [state(1, true, 60), state(2, false, 100), state(3, false, 90), state(4, true, 2), state(5, false, 300)]],
]);

describe("findStaleFlags", () => {
  it("finds flags that are the same everywhere and unchanged long enough", () => {
    const stale = findStaleFlags(features, states, [{ id: 7, label: "Permanent" }], 30, now);
    expect(stale.map((s) => [s.name, s.enabled, s.daysUnchanged])).toEqual([
      ["legacy_payments", false, 100],
      ["dark_mode", true, 60],
    ]);
  });

  it("treats different values as different settings", () => {
    const valued = new Map<string, FeatureState[]>([
      ["Development", [state(1, true, 90, 10)]],
      ["Production", [state(1, true, 90, 20)]],
    ]);
    expect(findStaleFlags([feature(1, "limit")], valued, [], 30, now)).toEqual([]);
  });

  it("uses the most recent change across environments", () => {
    expect(findStaleFlags(features, states, [], 61, now).map((s) => s.name)).not.toContain("dark_mode");
  });
});

describe("formatting", () => {
  const stale = findStaleFlags(features, states, [{ id: 7, label: "permanent" }], 30, now);
  const refs = new Map([
    ["dark_mode", [{ file: "src/layout.js", line: 10 }]],
    ["legacy_payments", []],
  ]);

  it("gives advice and code references in text", () => {
    const text = formatStale(stale, 30, refs);
    expect(text).toContain("dark_mode: on everywhere: remove the flag and keep the code path it turns on (unchanged for 60 days)");
    expect(text).toContain("used in: src/layout.js:10");
    expect(text).toContain("used in: not found in code");
  });

  it("makes a table in markdown", () => {
    const md = formatStaleMarkdown(stale, 30, refs);
    expect(md).toContain("**2 flags** have had the same setting");
    expect(md).toContain("| `dark_mode` | on | 60 days | Remove flag, keep the code it turns on | src/layout.js:10 |");
  });

  it("says so when nothing is stale", () => {
    expect(formatStale([], 30)).toBe("No stale flags (same in every environment and unchanged for 30+ days).");
  });
});
