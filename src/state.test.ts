import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPlans, liveFromDocument, type LiveSource } from "./state.js";
import type { EnvironmentDocument, FlagsmithClient } from "./flagsmith.js";
import { archiveConflicts, countActions, countDrift, formatDrift } from "./diff.js";
import { applyPlans } from "./apply.js";

const doc: EnvironmentDocument = {
  id: 3,
  name: "Production",
  api_key: "abc",
  project: { id: 1, name: "Shop" },
  feature_states: [
    { django_id: 10, feature: { id: 1, name: "checkout_v2" }, enabled: true, feature_state_value: "v2", feature_segment: null },
    { django_id: 11, feature: { id: 2, name: "dark_mode" }, enabled: false, feature_state_value: null, feature_segment: null },
    { django_id: 12, feature: { id: 1, name: "checkout_v2" }, enabled: false, feature_state_value: null, feature_segment: { id: 5 } },
  ],
};

describe("liveFromDocument", () => {
  it("reads each flag's environment default and skips segment overrides", () => {
    const live = liveFromDocument(doc);
    expect([...live.keys()]).toEqual(["checkout_v2", "dark_mode"]);
    expect(live.get("checkout_v2")).toEqual({ enabled: true, value: "v2", stateId: 10 });
    expect(live.get("dark_mode")).toEqual({ enabled: false, value: null, stateId: 11 });
  });
});

describe("buildPlans", () => {
  const source = (live: Record<string, boolean>, archived: string[] = []): LiveSource => ({
    listEnvironments: async () => [{ id: 1, name: "Production", api_key: "k", project: 1 }],
    readLive: async () =>
      new Map(Object.entries(live).map(([name, enabled], i) => [name, { enabled, value: null, stateId: i + 1 }])),
    missing: "Flagsmith only has",
    archived: async () => archived,
  });

  async function flagsDir(flags: string[]): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "flagops-"));
    const body = flags.map((f) => `  ${f}:\n    enabled: true\n    value: null\n`).join("");
    await writeFile(path.join(dir, "production.yaml"), `environment: Production\nflags:${body ? `\n${body}` : " {}\n"}`);
    return dir;
  }

  const readOnly = (live: Record<string, boolean>): LiveSource => ({ ...source(live), archived: undefined });
  const archivedDir = async () => {
    const dir = await flagsDir([]);
    await writeFile(path.join(dir, "production.yaml"), "environment: Production\nflags:\n  old:\n    archived: true\n    enabled: true\n    value: null\n");
    return dir;
  };

  it("reports a flag archived in Flagsmith but not in YAML, and apply refuses", async () => {
    const dir = await flagsDir(["dark_mode"]);
    const plans = await buildPlans(source({ dark_mode: true }, ["dark_mode"]), dir);
    expect(plans[0].changes).toEqual([{ kind: "status", flag: "dark_mode", archivedInGit: false }]);
    expect(countActions(plans)).toBe(0);
    expect(countDrift(plans)).toBe(1);
    expect(formatDrift(plans)).toContain("dark_mode: Git says not archived, Flagsmith has archived (archived outside Git)");
    expect(archiveConflicts(plans)[0]).toContain('"dark_mode" is archived in Flagsmith');
    await expect(applyPlans({} as FlagsmithClient, 1, plans)).rejects.toThrow(/archived in Flagsmith/);
  });

  it("checks an archived flag's settings in both modes, and never applies them", async () => {
    const dir = await archivedDir();
    // Same settings: nothing to report, in admin and read-only mode alike.
    expect((await buildPlans(source({ old: true }, ["old"]), dir))[0].changes).toEqual([]);
    expect((await buildPlans(readOnly({ old: true }), dir))[0].changes).toEqual([]);
    // Turned off in the dashboard after archiving: Flagsmith still serves it, so it is drift.
    for (const s of [source({ old: false }, ["old"]), readOnly({ old: false })]) {
      const plans = await buildPlans(s, dir);
      expect(plans[0].changes).toMatchObject([{ kind: "archived", flag: "old", before: { enabled: false } }]);
      expect(countDrift(plans)).toBe(1);
      expect(countActions(plans)).toBe(0);
    }
    // Deleted from Flagsmith: drift too.
    expect((await buildPlans(readOnly({}), dir))[0].changes).toMatchObject([{ kind: "archived", flag: "old", before: null }]);
  });

  it("reports a flag unarchived (or deleted and recreated) in Flagsmith as drift, not an error", async () => {
    const plans = await buildPlans(source({ old: true }), await archivedDir());
    expect(plans[0].changes).toEqual([{ kind: "status", flag: "old", archivedInGit: true }]);
    expect(formatDrift(plans)).toContain("(unarchived outside Git)");
  });

  it("reports an archived flag missing from YAML the same way in both modes", async () => {
    const dir = await flagsDir([]);
    const admin = await buildPlans(source({ old: true }, ["old"]), dir);
    const ro = await buildPlans(readOnly({ old: true }), dir);
    expect(admin[0].changes).toEqual(ro[0].changes);
    expect(admin[0].changes).toMatchObject([{ kind: "untracked", flag: "old" }]);
  });

  it("stops when a new flag differs from a live one only in case", async () => {
    const dir = await flagsDir(["Dark_Mode"]);
    await expect(buildPlans(source({ dark_mode: true }), dir)).rejects.toThrow(/differs only in case from "dark_mode"/);
  });

  it("plans normally otherwise", async () => {
    const dir = await flagsDir(["dark_mode"]);
    const [plan] = await buildPlans(source({ dark_mode: false }, ["old_flag"]), dir);
    expect(plan.changes).toMatchObject([{ kind: "update", flag: "dark_mode" }]);
  });
});
