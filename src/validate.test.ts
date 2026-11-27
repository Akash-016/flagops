import { describe, expect, it } from "vitest";
import { checkSameFlags, type NamedFlagFile } from "./validate.js";

const named = (source: string, flags: string[]): NamedFlagFile => ({
  source,
  file: { environment: source.replace(".yaml", ""), flags: Object.fromEntries(flags.map((f) => [f, { enabled: false, value: null }])) },
});

describe("checkSameFlags", () => {
  it("passes when every file lists the same flags", () => {
    expect(checkSameFlags([named("development.yaml", ["a", "b"]), named("production.yaml", ["b", "a"])])).toEqual([]);
  });

  it("reports a new flag added to only one file, naming where it is missing", () => {
    const problems = checkSameFlags([
      named("development.yaml", ["a", "new_flag"]),
      named("staging.yaml", ["a"]),
      named("production.yaml", ["a"]),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"new_flag" is in development.yaml but missing from staging.yaml, production.yaml');
  });

  it("has nothing to compare with a single file", () => {
    expect(checkSameFlags([named("production.yaml", ["a"])])).toEqual([]);
  });
});
