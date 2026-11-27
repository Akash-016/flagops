import { describe, expect, it } from "vitest";
import { liveFromDocument } from "./state.js";
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
