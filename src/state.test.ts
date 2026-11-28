import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPlans, liveFromDocument, type LiveSource } from "./state.js";
import type { EnvironmentDocument, FlagsmithClient } from "./flagsmith.js";
import { archiveConflicts, countActions, countDrift, formatDrift, segmentProblems } from "./diff.js";
import { applyPlans } from "./apply.js";

const doc: EnvironmentDocument = {
  id: 3,
  name: "Production",
  api_key: "abc",
  project: {
    id: 1,
    name: "Shop",
    segments: [
      { id: 7, name: "beta", feature_states: [{ django_id: 20, feature: { id: 1, name: "checkout_v2" }, enabled: false, feature_state_value: 3, feature_segment: { priority: 1 } }] },
      { id: 8, name: "staff", feature_states: [{ django_id: 21, feature: { id: 1, name: "checkout_v2" }, enabled: true, feature_state_value: null, feature_segment: { priority: 0 } }] },
    ],
  },
  feature_states: [
    { django_id: 10, feature: { id: 1, name: "checkout_v2" }, enabled: true, feature_state_value: "v2", feature_segment: null },
    { django_id: 11, feature: { id: 2, name: "dark_mode" }, enabled: false, feature_state_value: null, feature_segment: null },
    { django_id: 12, feature: { id: 1, name: "checkout_v2" }, enabled: false, feature_state_value: null, feature_segment: { priority: 0 } },
  ],
};

describe("liveFromDocument", () => {
  it("reads each flag's environment default, and its segment overrides in priority order", () => {
    const live = liveFromDocument(doc);
    expect([...live.keys()]).toEqual(["checkout_v2", "dark_mode"]);
    expect(live.get("checkout_v2")).toMatchObject({ enabled: true, value: "v2", stateId: 10, featureId: 1 });
    expect(live.get("checkout_v2")!.overrides!.map((o) => [o.segment, o.enabled, o.value])).toEqual([
      ["staff", true, null],
      ["beta", false, 3],
    ]);
    expect(live.get("dark_mode")).toEqual({ enabled: false, value: null, stateId: 11, featureId: 2, overrides: [], multivariate: false });
  });
});

describe("buildPlans", () => {
  const source = (live: Record<string, boolean>, archived: string[] = []): LiveSource => ({
    listEnvironments: async () => [{ id: 1, name: "Production", api_key: "k", project: 1 }],
    readLive: async () =>
      new Map(Object.entries(live).map(([name, enabled], i) => [name, { enabled, value: null, stateId: i + 1 }])),
    missing: "Flagsmith only has",
    archived: async () => archived,
    segmentNames: async () => ["beta", "staff", "twice", "twice"],
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

  it("checks and applies an archived flag's settings in both modes, since Flagsmith still serves it", async () => {
    const dir = await archivedDir();
    // Same settings: nothing to report, in admin and read-only mode alike.
    expect((await buildPlans(source({ old: true }, ["old"]), dir))[0].changes).toEqual([]);
    expect((await buildPlans(readOnly({ old: true }), dir))[0].changes).toEqual([]);
    // Turned off in the dashboard after archiving: Flagsmith still serves it, so it is drift.
    for (const s of [source({ old: false }, ["old"]), readOnly({ old: false })]) {
      const plans = await buildPlans(s, dir);
      expect(plans[0].changes).toMatchObject([{ kind: "update", flag: "old", before: { enabled: false } }]);
      expect(countDrift(plans)).toBe(1);
      expect(countActions(plans)).toBe(1);
    }
    // Deleted from Flagsmith: drift, but apply can't create an archived flag.
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

  it("reports a segment name that's missing or not unique as drift, and leaves that flag's overrides alone", async () => {
    const dir = await flagsDir([]);
    const seg = (name: string) => `environment: Production
flags:
  a:
    enabled: true
    value: null
    segments:
      - segment: ${name}
        enabled: true
        value: null
`;
    await writeFile(path.join(dir, "production.yaml"), seg("nope"));
    const [missing] = await buildPlans(source({ a: true }), dir);
    expect(missing.changes).toEqual([{ kind: "segment", flag: "a", segment: "nope", found: 0 }]);
    expect(countDrift([missing])).toBe(1);
    expect(countActions([missing])).toBe(0);
    expect(segmentProblems([missing])[0]).toContain("segment \"nope\" isn't in Flagsmith (renamed or deleted?)");
    await writeFile(path.join(dir, "production.yaml"), seg("twice"));
    expect((await buildPlans(source({ a: true }), dir))[0].changes).toEqual([{ kind: "segment", flag: "a", segment: "twice", found: 2 }]);
    await writeFile(path.join(dir, "production.yaml"), seg("beta"));
    const [plan] = await buildPlans(source({ a: true }), dir);
    expect(plan.changes).toMatchObject([{ kind: "override", flag: "a", segment: "beta", before: null }]);
    expect(plan.segmentOrder.get("a")).toEqual(["beta"]);
  });

  it("leaves out skipped environments, and stops on an unknown one", async () => {
    const dir = await flagsDir(["dark_mode"]);
    await writeFile(path.join(dir, "qa.yaml"), "environment: QA\nflags:\n  dark_mode:\n    enabled: true\n    value: null\n");
    const twoEnvs: LiveSource = {
      ...source({ dark_mode: false }),
      listEnvironments: async () => [{ id: 1, name: "Production", api_key: "k", project: 1 }, { id: 2, name: "QA", api_key: "q", project: 1 }],
    };
    expect((await buildPlans(twoEnvs, dir, undefined, ["production"])).map((p) => p.environment)).toEqual(["QA"]);
    await expect(buildPlans(twoEnvs, dir, undefined, ["Prod"])).rejects.toThrow(/to skip: prod/);
  });

  it("plans normally otherwise", async () => {
    const dir = await flagsDir(["dark_mode"]);
    const [plan] = await buildPlans(source({ dark_mode: false }, ["old_flag"]), dir);
    expect(plan.changes).toMatchObject([{ kind: "update", flag: "dark_mode" }]);
  });
});
