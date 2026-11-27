import { describe, expect, it } from "vitest";
import { buildFlagFile, fileNameFor, parseFlagFile, toYaml } from "./flagfile.js";
import type { Feature, FeatureState } from "./flagsmith.js";

const feature = (id: number, name: string, is_archived = false): Feature => ({ id, name, is_archived });
const state = (feature: number, enabled: boolean, value: FeatureState["feature_state_value"] = null): FeatureState => ({
  id: feature * 10,
  feature,
  enabled,
  feature_state_value: value,
  identity: null,
  feature_segment: null,
});

describe("fileNameFor", () => {
  it("makes a safe lowercase file name", () => {
    expect(fileNameFor("Production")).toBe("production.yaml");
    expect(fileNameFor("QA / Staging 2")).toBe("qa-staging-2.yaml");
  });
});

describe("buildFlagFile", () => {
  it("sorts flags by name and keeps values", () => {
    const file = buildFlagFile(
      "Production",
      [feature(2, "zeta"), feature(1, "alpha")],
      [state(1, true, "v2"), state(2, false, 5)],
    );
    expect(Object.keys(file.flags)).toEqual(["alpha", "zeta"]);
    expect(file.flags.alpha).toEqual({ enabled: true, value: "v2" });
    expect(file.flags.zeta).toEqual({ enabled: false, value: 5 });
  });

  it("skips archived flags and flags with no state", () => {
    const file = buildFlagFile("Dev", [feature(1, "old", true), feature(2, "orphan")], [state(1, true)]);
    expect(file.flags).toEqual({});
  });
});

describe("parseFlagFile", () => {
  it("round-trips through YAML", () => {
    const original = buildFlagFile("Dev", [feature(1, "a")], [state(1, true, "x")]);
    expect(parseFlagFile(toYaml(original), "dev.yaml")).toEqual(original);
  });

  it("rejects a missing value and unknown keys, so a typo can't turn a value into null", () => {
    expect(() => parseFlagFile("environment: Dev\nflags:\n  a:\n    enabled: true\n", "dev.yaml")).toThrow(/flags\.a\.value: missing/);
    expect(() => parseFlagFile("environment: Dev\nflags:\n  a:\n    enabled: true\n    value: null\n    vaule: 25\n", "dev.yaml")).toThrow(/vaule/);
    expect(() => parseFlagFile("enviroment: Dev\nflags: {}\n", "dev.yaml")).toThrow(/enviroment/);
  });

  it("rejects values Flagsmith would store differently", () => {
    const bad = (value: string) => () =>
      parseFlagFile(`environment: Dev\nflags:\n  a:\n    enabled: true\n    value: ${value}\n`, "dev.yaml");
    expect(bad("1.5")).toThrow(/whole numbers/);
    expect(bad("99999999999")).toThrow(/too big/);
    expect(bad('"  padded  "')).toThrow(/trims/);
    expect(bad("x".repeat(20001))).toThrow(/longer than/);
    expect(bad('"1.5"')).not.toThrow();
    expect(bad("-5")).not.toThrow();
  });

  it("rejects flag names that could break the Markdown in pull request comments", () => {
    expect(() => parseFlagFile("environment: Dev\nflags:\n  'evil`|x':\n    enabled: true\n    value: null\n", "dev.yaml")).toThrow(/flag names/);
  });

  it("explains what is wrong with a bad file", () => {
    expect(() => parseFlagFile("environment: Dev\nflags:\n  a:\n    enabled: maybe\n", "dev.yaml")).toThrow(
      /flags\.a\.enabled/,
    );
  });
});
