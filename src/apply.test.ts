import { describe, expect, it } from "vitest";
import { applyPlans } from "./apply.js";
import { diffEnvironment, guardOutput, type LiveFlags } from "./diff.js";
import { sameOrigin, type FlagsmithClient } from "./flagsmith.js";
import type { FlagFile } from "./flagfile.js";
import type { PlannedEnvironment } from "./state.js";

// A fake Admin API that records calls and can fail on one of them.
function fakeClient(failOn?: string) {
  const calls: string[] = [];
  const call = async (name: string) => {
    calls.push(name);
    if (name === failOn) throw new Error("Flagsmith said no");
  };
  const client = {
    updateState: (_k: string, id: number) => call(`updateState ${id}`),
    createFeature: async (_p: number, name: string) => (await call(`createFeature ${name}`), { id: 99, name, is_archived: false }),
    findEnvironmentState: async () => ({ id: 500, feature: 99, enabled: false, feature_state_value: null, identity: null, feature_segment: null }),
    listSegments: async () => [{ id: 7, name: "beta" }, { id: 8, name: "staff" }],
    createOverride: (_k: string, f: number, seg: number) => call(`createOverride ${f} ${seg}`),
    updateOverride: (o: { stateId: number }) => call(`updateOverride ${o.stateId}`),
    deleteOverride: (fs: number) => call(`deleteOverride ${fs}`),
    // After the creates, Flagsmith lists the overrides with new ones last.
    listFeatureSegments: async () => [
      { id: 71, segment: 7, segment_name: "beta", priority: 0 },
      { id: 81, segment: 8, segment_name: "staff", priority: 1 },
    ],
    setPriorities: (order: { id: number; priority: number }[]) => call(`setPriorities ${order.map((o) => o.id).join(",")}`),
  };
  return { client: client as unknown as FlagsmithClient, calls };
}

const env = { id: 3, name: "Production", api_key: "k", project: 1 };

function planned(flags: FlagFile["flags"], live: LiveFlags, extra: Partial<PlannedEnvironment> = {}): PlannedEnvironment {
  return {
    ...diffEnvironment({ environment: "Production", flags }, live, undefined, new Map([["beta", 1], ["staff", 1], ["gone", 0]])),
    env,
    featureIds: new Map([...live].map(([n, l]) => [n, l.featureId ?? 0])),
    segmentOrder: new Map(Object.entries(flags).flatMap(([n, e]) => (e.segments ? [[n, e.segments.map((o) => o.segment)] as [string, string[]]] : []))),
    multivariate: new Set(),
    ...extra,
  };
}

const flagWith = (segments: { segment: string; enabled: boolean; value: null | number }[]) => ({ f: { enabled: true, value: null, segments } });
const liveF = (overrides: { segment: string; enabled: boolean; value: null | number; stateId: number; featureSegmentId: number }[]): LiveFlags =>
  new Map([["f", { enabled: true, value: null, stateId: 1, featureId: 5, overrides }]]);

describe("applyPlans", () => {
  it("creates, updates and removes overrides, then sets the order YAML gives", async () => {
    const { client, calls } = fakeClient();
    const plan = planned(
      flagWith([
        { segment: "staff", enabled: true, value: 1 },
        { segment: "beta", enabled: true, value: null },
      ]),
      liveF([
        { segment: "beta", enabled: false, value: null, stateId: 20, featureSegmentId: 71 },
        { segment: "old", enabled: true, value: null, stateId: 30, featureSegmentId: 91 },
      ]),
    );
    const result = await applyPlans(client, 1, [plan]);
    expect(result.failed).toBeUndefined();
    expect(calls).toEqual(["createOverride 5 8", "updateOverride 20", "deleteOverride 91", "setPriorities 81,71"]);
    expect(result.applied.at(-1)).toBe("Production: ~ f segment order staff, beta");
  });

  it("stops at the first failure and says what was done", async () => {
    const { client, calls } = fakeClient("deleteOverride 91");
    const plan = planned(
      flagWith([{ segment: "beta", enabled: true, value: null }]),
      liveF([
        { segment: "beta", enabled: false, value: null, stateId: 20, featureSegmentId: 71 },
        { segment: "old", enabled: true, value: null, stateId: 30, featureSegmentId: 91 },
      ]),
    );
    const result = await applyPlans(client, 1, [plan]);
    expect(result.applied).toEqual(["Production: ~ f [segment beta]"]);
    expect(result.failed).toEqual({ what: "Production: - f [segment old]", error: "Flagsmith said no" });
    expect(calls).not.toContain("setPriorities 71");
  });

  it("leaves a flag's overrides alone when its segment is gone, applies the rest, and reports it", async () => {
    const { client, calls } = fakeClient();
    const live: LiveFlags = new Map([
      ["f", { enabled: true, value: null, stateId: 1, featureId: 5, overrides: [] }],
      ["g", { enabled: false, value: null, stateId: 2, featureId: 6, overrides: [] }],
    ]);
    const plan = planned({ f: { enabled: true, value: null, segments: [{ segment: "gone", enabled: true, value: null }] }, g: { enabled: true, value: null } }, live);
    const result = await applyPlans(client, 1, [plan]);
    expect(calls).toEqual(["updateState 2"]);
    expect(result.skipped?.[0]).toContain('segment "gone" isn\'t in Flagsmith');
  });

  it("changes nothing in an environment that uses feature versioning", async () => {
    const { client, calls } = fakeClient();
    const plan = planned({ f: { enabled: false, value: null } }, liveF([]), { env: { ...env, use_v2_feature_versioning: true } });
    await expect(applyPlans(client, 1, [plan])).rejects.toThrow(/feature versioning \(v2\)/);
    expect(calls).toEqual([]);
  });

  it("doesn't plan overrides for an archived flag missing from Flagsmith", () => {
    const plan = planned({ ghost: { archived: true, enabled: true, value: null, segments: [{ segment: "beta", enabled: true, value: null }] } }, new Map());
    expect(plan.changes.map((c) => c.kind)).toEqual(["archived"]);
  });
});

describe("output and paging guards", () => {
  it("breaks runner commands anywhere in a line", () => {
    expect(guardOutput("  + promo ##[add-mask]Production: new flag")).toBe("  + promo ## [add-mask]Production: new flag");
    expect(guardOutput("::error::x")).toBe(": :error::x");
  });

  it("keeps paging links on the configured Flagsmith", () => {
    const api = "https://flagsmith.example.com/api/v1";
    expect(sameOrigin("http://flagsmith.example.com/api/v1/features/?page=2", api)).toBe("https://flagsmith.example.com/api/v1/features/?page=2");
    expect(sameOrigin("https://evil.example/api/v1/x/?page=2", api)).toBe("https://flagsmith.example.com/api/v1/x/?page=2");
    expect(sameOrigin("https://flagsmith.example.com//evil.example/api/v1/x/?page=2", api)).toBe("https://flagsmith.example.com/evil.example/api/v1/x/?page=2");
  });
});
