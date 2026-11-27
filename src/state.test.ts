import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPlans, liveFromDocument, type LiveSource } from "./state.js";
import type { EnvironmentDocument } from "./flagsmith.js";

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
    await writeFile(path.join(dir, "production.yaml"), `environment: Production\nflags:\n${body}`);
    return dir;
  }

  it("stops before apply when a flag in YAML is archived in Flagsmith", async () => {
    const dir = await flagsDir(["dark_mode"]);
    await expect(buildPlans(source({}, ["dark_mode"]), dir)).rejects.toThrow(/"dark_mode" is archived in Flagsmith/);
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
