import { describe, expect, it } from "vitest";
import {
  COMMENT_MARKER,
  DRIFT_MARKER,
  countActions,
  countDrift,
  diffEnvironment,
  formatDrift,
  formatDriftMarkdown,
  formatPlan,
  formatPlanMarkdown,
  sortByEnvironment,
  type LiveFlags,
} from "./diff.js";
import type { FlagFile } from "./flagfile.js";

const live = (entries: Record<string, [boolean, string | number | boolean | null]>): LiveFlags =>
  new Map(Object.entries(entries).map(([name, [enabled, value]], i) => [name, { enabled, value, stateId: i + 1 }]));

const wanted = (flags: FlagFile["flags"]): FlagFile => ({ environment: "Production", flags });

describe("diffEnvironment", () => {
  it("finds nothing when YAML matches Flagsmith", () => {
    const plan = diffEnvironment(wanted({ a: { enabled: true, value: null } }), live({ a: [true, null] }));
    expect(plan.changes).toEqual([]);
  });

  it("finds an on/off change and keeps the state id", () => {
    const plan = diffEnvironment(wanted({ a: { enabled: true, value: null } }), live({ a: [false, null] }));
    expect(plan.changes).toEqual([
      { kind: "update", flag: "a", before: { enabled: false, value: null }, after: { enabled: true, value: null }, stateId: 1 },
    ]);
  });

  it("finds a value change", () => {
    const plan = diffEnvironment(wanted({ a: { enabled: true, value: "v2" } }), live({ a: [true, "v1"] }));
    expect(plan.changes[0]).toMatchObject({ kind: "update", flag: "a" });
  });

  it("treats 5 and '5' as different values", () => {
    const plan = diffEnvironment(wanted({ a: { enabled: true, value: "5" } }), live({ a: [true, 5] }));
    expect(plan.changes).toHaveLength(1);
  });

  it("marks flags missing from Flagsmith as new", () => {
    const plan = diffEnvironment(wanted({ b: { enabled: false, value: null } }), live({}));
    expect(plan.changes).toEqual([{ kind: "create", flag: "b", after: { enabled: false, value: null } }]);
  });

  it("marks flags missing from YAML as untracked, not deleted", () => {
    const plan = diffEnvironment(wanted({}), live({ old: [true, null] }));
    expect(plan.changes).toEqual([{ kind: "untracked", flag: "old", before: { enabled: true, value: null } }]);
  });
});

describe("formatPlanMarkdown", () => {
  it("starts with the marker and warns about production changes", () => {
    const plan = diffEnvironment(wanted({ a: { enabled: true, value: "x|y" } }), live({ a: [false, null] }));
    const md = formatPlanMarkdown([plan]);
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain("### Production (production)");
    expect(md).toContain("A reviewer must approve");
    expect(md).toContain("| ~ | `a` | off, `null` | **on, `\"x\\|y\"`** |");
  });

  it("says so when there is nothing to change", () => {
    const plan = diffEnvironment(wanted({ a: { enabled: true, value: null } }), live({ a: [true, null] }));
    const md = formatPlanMarkdown([plan]);
    expect(md).toContain("No flag changes.");
    expect(md).not.toContain("approve");
  });

  it("lists unchanged environments on one line instead of a section each", () => {
    const changed = diffEnvironment(wanted({ a: { enabled: true, value: null } }), live({ a: [false, null] }));
    const same = { environment: "Staging", changes: [] };
    const md = formatPlanMarkdown([same, changed]);
    expect(md).toContain("**1 change** will be applied");
    expect(md).not.toContain("### Staging");
    expect(md).toContain("No changes in: Staging.");
  });
});

describe("blast radius in the plan", () => {
  it("lists where each changed flag is used, but not untracked ones", () => {
    const plan = diffEnvironment(
      wanted({ cart: { enabled: true, value: 25 }, banner: { enabled: true, value: null } }),
      live({ cart: [true, 10], banner: [false, null], old: [true, null] }),
    );
    const refs = new Map([
      ["cart", [{ file: "src/cart.ts", line: 4 }]],
      ["banner", []],
    ]);
    const md = formatPlanMarkdown([plan], refs);
    expect(md).toContain("### Where these flags are used");
    expect(md).toContain("- `banner`: not found in code");
    expect(md).toContain("- `cart`: `src/cart.ts:4`");
    expect(md).not.toContain("- `old`");
    expect(formatPlan([plan], refs)).toContain("  cart: src/cart.ts:4");
  });
});

describe("drift", () => {
  it("reports changed, deleted and added flags from Git's point of view", () => {
    const plan = diffEnvironment(
      wanted({ cart: { enabled: true, value: 10 }, gone: { enabled: true, value: null } }),
      live({ cart: [true, 99], extra: [false, null] }),
    );
    expect(countDrift([plan])).toBe(3);
    const md = formatDriftMarkdown([plan]);
    expect(md.startsWith(DRIFT_MARKER)).toBe(true);
    expect(md).toContain("**3 flags** in Flagsmith no longer match");
    expect(md).toContain("| `cart` | on, `10` | **on, `99`** | changed outside Git |");
    expect(md).toContain("| `gone` | on, `null` | **missing** | deleted outside Git |");
    expect(md).toContain("| `extra` | (not in Git) | **off, `null`** | added outside Git |");
    expect(formatDrift([plan])).toContain("cart: Git says on, 10, Flagsmith has on, 99 (changed outside Git)");
  });

  it("reports no drift when everything matches", () => {
    const plan = diffEnvironment(wanted({ a: { enabled: true, value: null } }), live({ a: [true, null] }));
    expect(countDrift([plan])).toBe(0);
    expect(formatDriftMarkdown([plan])).toContain("## No flag drift");
    expect(formatDrift([plan])).toBe("No drift: Flagsmith matches the flag files.");
  });
});

describe("sortByEnvironment", () => {
  it("puts development first and production last", () => {
    const names = ["Production", "Staging", "Development", "QA"].map((environment) => ({ environment }));
    expect(sortByEnvironment(names).map((p) => p.environment)).toEqual(["Development", "QA", "Staging", "Production"]);
  });
});

describe("countActions and formatPlan", () => {
  it("does not count untracked flags as actions", () => {
    const plan = diffEnvironment(
      wanted({ a: { enabled: true, value: null } }),
      live({ a: [false, null], old: [true, null] }),
    );
    expect(countActions([plan])).toBe(1);
    expect(formatPlan([plan])).toBe(
      [
        "Production:",
        "  ~ a: off -> on",
        "  ! old: in Flagsmith but not in YAML (left alone)",
        "",
        "1 change to apply.",
      ].join("\n"),
    );
  });
});
