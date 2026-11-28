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

  it("marks archived flags, keeps their settings, and skips flags with no state", () => {
    const file = buildFlagFile("Dev", [feature(1, "old", true), feature(2, "orphan")], [state(1, true, "v")]);
    expect(file.flags).toEqual({ old: { archived: true, enabled: true, value: "v" } });
  });

  it("writes files that parse back, whatever names Flagsmith allows", () => {
    const names = ["bad name", "<b>x</b>", "@here", "émoji", "a|b", "x`y", "old"];
    const original = buildFlagFile("Dev", names.map((n, i) => feature(i + 1, n, n === "old")), names.map((_, i) => state(i + 1, true, "v")));
    expect(parseFlagFile(toYaml(original), "dev.yaml")).toEqual(original);
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

  it("rejects flag names with control characters", () => {
    expect(() => parseFlagFile('environment: Dev\nflags:\n  "a\\nb":\n    enabled: true\n    value: null\n', "dev.yaml")).toThrow(/control characters/);
  });

  it("rejects values Flagsmith would trim with Python's rules", () => {
    expect(() => parseFlagFile('environment: Dev\nflags:\n  a:\n    enabled: true\n    value: "sale\x1f"\n', "dev.yaml")).toThrow(/trims/);
  });

  it("keeps an archived flag's settings, since Flagsmith still serves them", () => {
    const file = parseFlagFile("environment: Dev\nflags:\n  old:\n    archived: true\n    enabled: true\n    value: 3\n", "dev.yaml");
    expect(file.flags.old).toEqual({ archived: true, enabled: true, value: 3 });
    expect(() => parseFlagFile("environment: Dev\nflags:\n  old:\n    archived: true\n", "dev.yaml")).toThrow(/flags\.old\.enabled: missing/);
  });

  const named = (name: string) => () =>
    parseFlagFile(`environment: Dev\nflags:\n  ${JSON.stringify(name)}:\n    enabled: true\n    value: null\n`, "dev.yaml");
  const valued = (v: string) => () =>
    parseFlagFile(`environment: Dev\nflags:\n  a:\n    enabled: true\n    value: ${JSON.stringify(v)}\n`, "dev.yaml");

  it("rejects names Flagsmith would trim or refuse", () => {
    expect(named(" lead")).toThrow(/trims leading and trailing spaces from flag names/);
    expect(named("trail" + String.fromCharCode(0x3000))).toThrow(/trims/);
    // Through toYaml, as pull writes them: YAML needs an explicit key over 1024 characters.
    const long = (n: number) => () => parseFlagFile(toYaml(buildFlagFile("Dev", [feature(1, "x".repeat(n))], [state(1, true)])), "dev.yaml");
    expect(long(2001)).toThrow(/at most 2000/);
    expect(long(2000)).not.toThrow();
  });

  it("rejects __proto__ and invisible characters in names, and accepts an empty flags list", () => {
    expect(() => parseFlagFile('environment: Dev\nflags:\n  __proto__:\n    enabled: true\n    value: null\n', "dev.yaml")).toThrow(/__proto__/);
    expect(named("dark" + String.fromCharCode(0x200b) + "mode")).toThrow(/invisible/);
    expect(parseFlagFile("environment: Dev\nflags:\n", "dev.yaml").flags).toEqual({});
    expect(Object.keys(buildFlagFile("Dev", [feature(1, "__proto__"), feature(2, "constructor")], [state(1, true), state(2, true)]).flags)).toEqual(["constructor"]);
  });

  it("rejects text-direction characters in names, which can make one name look like another", () => {
    expect(named("admin" + String.fromCharCode(0x202e) + "nimda")).toThrow(/text-direction/);
    expect(named("flag" + String.fromCharCode(0x2066))).toThrow(/text-direction/);
  });

  it("trims like Python's strip(): Flagsmith keeps a leading U+FEFF, so it is allowed", () => {
    expect(valued(String.fromCharCode(0xfeff) + "a")).not.toThrow();
    expect(valued("a" + String.fromCharCode(0xa0))).toThrow(/trims/);
    expect(valued(String.fromCharCode(0x2028) + "a")).toThrow(/trims/);
  });

  it("reads segment overrides in order, and checks them like flag settings", () => {
    const base = "environment: Dev\nflags:\n  a:\n    enabled: false\n    value: null\n    segments:\n";
    const file = parseFlagFile(base + "      - segment: staff\n        enabled: true\n        value: 5\n      - segment: beta\n        enabled: false\n        value: null\n", "dev.yaml");
    expect(file.flags.a.segments).toEqual([
      { segment: "staff", enabled: true, value: 5 },
      { segment: "beta", enabled: false, value: null },
    ]);
    expect(parseFlagFile(base.replace("segments:\n", "segments: []\n"), "dev.yaml").flags.a.segments).toEqual([]);
    expect(() => parseFlagFile(base + "      - segment: b\n        enabled: true\n        value: 1\n      - segment: b\n        enabled: true\n        value: 1\n", "dev.yaml")).toThrow(/"b" is listed twice/);
    expect(() => parseFlagFile(base + "      - segment: b\n        enabled: true\n        value: 1.5\n", "dev.yaml")).toThrow(/whole numbers/);
    expect(() => parseFlagFile(base + "      - segment: b\n        enabled: true\n", "dev.yaml")).toThrow(/segments\.0\.value/);
  });

  it("writes every flag's overrides on pull, an empty list when it has none", () => {
    const file = buildFlagFile("Dev", [feature(1, "a"), feature(2, "b")], [state(1, true), state(2, false)], new Map([["a", [{ segment: "beta", enabled: false, value: 1 }]]]));
    expect(file.flags.a.segments).toEqual([{ segment: "beta", enabled: false, value: 1 }]);
    expect(file.flags.b.segments).toEqual([]);
    expect(parseFlagFile(toYaml(file), "dev.yaml")).toEqual(file);
  });

  it("keeps a flag but leaves its overrides out when a segment name isn't unique", () => {
    const file = buildFlagFile("Dev", [feature(1, "a")], [state(1, true)], new Map([["a", [{ segment: "staff", enabled: false, value: 1 }]]]), new Map([["staff", 2]]));
    expect(file.flags.a).toMatchObject({ enabled: true, value: null, dropSegments: '2 segments are named "staff"' });
    expect(file.flags.a.segments).toBeUndefined();
  });

  it("explains what is wrong with a bad file", () => {
    expect(() => parseFlagFile("environment: Dev\nflags:\n  a:\n    enabled: maybe\n", "dev.yaml")).toThrow(
      /flags\.a\.enabled/,
    );
  });
});
