import { describe, expect, it } from "vitest";
import {
  COMMENT_MARKER,
  countActions,
  diffEnvironment,
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
