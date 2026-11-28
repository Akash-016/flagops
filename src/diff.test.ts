import { describe, expect, it } from "vitest";
import {
  COMMENT_MARKER,
  DRIFT_MARKER,
  changedFlags,
  countActions,
  countDrift,
  diffEnvironment,
  formatDrift,
  formatDriftMarkdown,
  formatPlan,
  formatPlanMarkdown,
  guardOutput,
  multivariateNote,
  planFailedMarkdown,
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

  it("handles flags named like built-in object properties", () => {
    const plan = diffEnvironment(wanted({ toString: { enabled: true, value: null } }), live({ constructor: [true, null], hasOwnProperty: [false, null] }));
    expect(plan.changes.map((c) => [c.kind, c.flag])).toEqual([
      ["untracked", "constructor"],
      ["untracked", "hasOwnProperty"],
      ["create", "toString"],
    ]);
  });

  it("marks flags missing from YAML as untracked, not deleted", () => {
    const plan = diffEnvironment(wanted({}), live({ old: [true, null] }));
    expect(plan.changes).toEqual([{ kind: "untracked", flag: "old", before: { enabled: true, value: null } }]);
  });
});

describe("segment overrides", () => {
  const ov = (segment: string, enabled: boolean, value: string | number | null, id: number) => ({ segment, enabled, value, stateId: id, featureSegmentId: id * 10 });
  const liveWith = (overrides: ReturnType<typeof ov>[]): LiveFlags =>
    new Map([["f", { enabled: true, value: null, stateId: 1, featureId: 5, overrides }]]);
  const want = (segments?: { segment: string; enabled: boolean; value: string | number | null }[]) =>
    wanted({ f: { enabled: true, value: null, ...(segments ? { segments } : {}) } });

  it("leaves overrides alone when YAML has no segments key", () => {
    expect(diffEnvironment(want(), liveWith([ov("beta", true, 1, 1)])).changes).toEqual([]);
  });

  it("adds, changes and removes overrides, and reports a new order", () => {
    const plan = diffEnvironment(
      want([
        { segment: "staff", enabled: true, value: 2 },
        { segment: "beta", enabled: false, value: 1 },
        { segment: "new", enabled: true, value: null },
      ]),
      liveWith([ov("beta", true, 1, 1), ov("staff", true, 2, 2), ov("old", true, null, 3)]),
    );
    expect(plan.changes.map((c) => [c.kind, "segment" in c ? c.segment : "", "before" in c && c.before ? "had" : "-", "after" in c && c.after ? "wants" : "-"])).toEqual([
      ["override", "beta", "had", "wants"],
      ["override", "new", "-", "wants"],
      ["override", "old", "had", "-"],
      ["order", "", "had", "wants"],
    ]);
    expect(countActions([plan])).toBe(4);
    expect(changedFlags([plan])).toEqual(["f"]);
    const text = formatPlan([plan]);
    expect(text).toContain("  ~ f [segment beta]: on, value 1 -> off, value 1");
    expect(text).toContain("  + f [segment new]: new override (on, value null)");
    expect(text).toContain("  - f [segment old]: override removed (was on, value null)");
    expect(text).toContain("  ~ f: segment order beta, staff, old -> staff, beta, new");
    const md = formatPlanMarkdown([plan]);
    expect(md).toContain("| + | <code>f</code> for segment <code>new</code> | (new override) | **on, <code>null</code>** |");
    expect(md).toContain("| - | <code>f</code> for segment <code>old</code> | on, <code>null</code> | **override removed** |");
    const drift = formatDrift([plan]);
    expect(drift).toContain("(override added outside Git)");
    expect(drift).toContain("(override deleted outside Git)");
    expect(drift).toContain("(segment order changed outside Git)");
  });

  it("doesn't report order when only new overrides change positions", () => {
    const plan = diffEnvironment(want([{ segment: "new", enabled: true, value: null }, { segment: "beta", enabled: true, value: 1 }]), liveWith([ov("beta", true, 1, 1)]));
    expect(plan.changes.map((c) => c.kind)).toEqual(["override"]);
  });

  it("applies an archived flag's overrides too, since Flagsmith still serves them", () => {
    const plan = diffEnvironment(
      wanted({ f: { archived: true, enabled: true, value: null, segments: [{ segment: "beta", enabled: false, value: null }] } }),
      liveWith([ov("beta", true, null, 1)]),
    );
    expect(plan.changes).toMatchObject([{ kind: "override", segment: "beta" }]);
    expect(countActions([plan])).toBe(1);
  });
});

describe("formatPlanMarkdown", () => {
  it("starts with the marker and warns about production changes", () => {
    const plan = diffEnvironment(wanted({ a: { enabled: true, value: "x|y" } }), live({ a: [false, null] }));
    const md = formatPlanMarkdown([plan]);
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain("### <code>Production</code> (production)");
    expect(md).toContain("A reviewer must approve");
    expect(md).toContain("| ~ | <code>a</code> | off, <code>null</code> | **on, <code>&#34;x&#124;y&#34;</code>** |");
  });

  it("can't be broken by names, values or environment names set in the Flagsmith dashboard", () => {
    const evil = "evil`|<!-- @someone **x** #1 :rocket: 😀";
    const plan = { ...diffEnvironment(wanted({}), live({ [evil]: [true, evil] })), environment: "#2 GH-3 :tada:" };
    const md = formatPlanMarkdown([plan]);
    const body = md.slice(COMMENT_MARKER.length);
    const shown = body.replace(/&#\d+;/g, ""); // what GitHub could still parse once entities are set aside
    for (const bad of ["`", "<!--", "@someone", "**x", "#1", ":rocket:", "#2", ":tada:"]) expect(shown).not.toContain(bad);
    expect(body).not.toContain("&#55357;");
    expect(body).toContain("&#128512;"); // the emoji as one code point, not two halves
    expect(body).toContain("### <code>&#35;2 GH-3 &#58;tada&#58;</code>");
    const rows = body.split("\n").filter((l) => l.includes("evil"));
    expect(rows).toHaveLength(1);
    expect(rows[0].split("|")).toHaveLength(6); // the name's pipe didn't add a column
  });

  it("leaves names a flag file can't hold out of drift (pull skips them and says why)", () => {
    const plan = diffEnvironment(wanted({}), live({ "tab\there": [true, null], " lead": [true, null] }));
    expect(plan.changes).toEqual([]);
  });

  it("stops Markdown emphasis, links and email links from names and values", () => {
    // Each form below was checked against GitHub's Markdown renderer.
    const plan = diffEnvironment(wanted({}), live({ __init__: [true, "https://evil.example/x"], _beta_: [true, "a@b.io www.x.io"] }));
    const md = formatPlanMarkdown([plan]);
    expect(md).toContain("<code>&#95;&#95;init&#95;&#95;</code>");
    expect(md).toContain("https&#58;//evil&#46;example/x");
    expect(md).toContain("a&#64;<wbr>b&#46;io www&#46;x&#46;io");
    expect(md).not.toMatch(/https:|www\.|@b|__/);
    expect(formatDrift([plan])).toContain('_beta_: Git says (not in Git), Flagsmith has on, "a@b.io www.x.io"');
  });

  it("can't start a workflow command in a log, from output or error messages", () => {
    const plan = { ...diffEnvironment(wanted({}), live({ a: [true, null] })), environment: "QA\n::warning::y" };
    expect(formatPlan([plan])).toContain('"QA\\n::warning::y":');
    expect(guardOutput("Missing environment QA\n::warning::y and\r::error::z")).toBe("Missing environment QA\n: :warning::y and\\r::error::z");
    expect(guardOutput("  ::notice::x")).toBe("  : :notice::x");
  });

  it("applies an archived flag's settings, and puts a summary line and notes up top", () => {
    const dev = { ...diffEnvironment(wanted({ a: { enabled: true, value: null } }), live({ a: [false, null] })), environment: "Development" };
    const prod = diffEnvironment(
      wanted({ a: { enabled: true, value: null }, old: { archived: true, enabled: true, value: null } }),
      live({ a: [false, null], old: [false, null] }),
    );
    const md = formatPlanMarkdown([dev, prod], undefined, ["read-only note"]);
    expect(md).toContain("**3 changes**");
    expect(md).toContain("<code>Development</code>: 1 · <code>Production</code>: 2");
    expect(md).toContain("> read-only note");
    expect(md).toContain("| ~ | <code>old</code> | off, <code>null</code> | **on, <code>null</code>** |");
  });

  it("reports an archived flag missing from Flagsmith, without trying to create it", () => {
    const plan = diffEnvironment(wanted({ old: { archived: true, enabled: false, value: null } }), live({}));
    expect(plan.changes).toMatchObject([{ kind: "archived", flag: "old" }]);
    expect(countActions([plan])).toBe(0);
    expect(countDrift([plan])).toBe(1);
  });

  it("escapes flag names in the multivariate note", () => {
    const note = multivariateNote(["mv @octocat [x](https://evil.example) <img src=x> **b**"]);
    for (const bad of ["@octocat", "[x]", "https:", "<img", "**b"]) expect(note).not.toContain(bad);
    expect(note).toContain("<code>mv &#64;<wbr>octocat");
  });

  it("lists production first, so a comment cut short loses other environments' rows", () => {
    const dev = { ...diffEnvironment(wanted({ a: { enabled: true, value: null } }), live({ a: [false, null] })), environment: "Development" };
    const prod = diffEnvironment(wanted({ a: { enabled: true, value: null } }), live({ a: [false, null] }));
    const md = formatPlanMarkdown([dev, prod]);
    expect(md.indexOf("### <code>Production</code>")).toBeLessThan(md.indexOf("### <code>Development</code>"));
    const drift = formatDriftMarkdown([dev, prod]);
    expect(drift.indexOf("### <code>Production</code>")).toBeLessThan(drift.indexOf("### <code>Development</code>"));
  });

  it("treats any production-like name as production: warning, and listed first", () => {
    const dev = { ...diffEnvironment(wanted({ a: { enabled: true, value: null } }), live({ a: [false, null] })), environment: "Dev-b" };
    const dev2 = { ...dev, environment: "Dev-a" };
    const prod = { ...dev, environment: "Prod" };
    const md = formatPlanMarkdown([dev2, dev, prod]);
    expect(md).toContain("### <code>Prod</code> (production)");
    expect(md).toContain("A reviewer must approve");
    expect(md.indexOf("<code>Prod</code> (production)")).toBeLessThan(md.indexOf("### <code>Dev-a</code>"));
    expect(md.indexOf("### <code>Dev-a</code>")).toBeLessThan(md.indexOf("### <code>Dev-b</code>"));
  });

  it("recognises production as a whole word, not a substring", () => {
    const plan = diffEnvironment(wanted({ a: { enabled: true, value: null } }), live({ a: [false, null] }));
    const md = (environment: string) => formatPlanMarkdown([{ ...plan, environment }]);
    for (const name of ["Production", "prod-eu", "prd", "Live", "live-eu"]) expect(md(name)).toContain("(production)");
    for (const name of ["Non-Prod", "nonprod", "Preprod", "Pre-Prod", "Product Sandbox", "Development"]) expect(md(name)).not.toContain("(production)");
    const order = sortByEnvironment(["Production", "Non-Prod", "Development", "Preprod"].map((environment) => ({ environment })));
    expect(order.map((p) => p.environment)).toEqual(["Development", "Non-Prod", "Preprod", "Production"]);
  });

  it("shortens very long values for reading, but compares the full value", () => {
    const long = "x".repeat(20000);
    const plan = diffEnvironment(wanted({ a: { enabled: true, value: long } }), live({ a: [true, long.slice(0, 19999) + "y"] }));
    expect(plan.changes).toHaveLength(1);
    const out = formatPlan([plan]);
    expect(out.length).toBeLessThan(600);
    expect(out).toContain("... (20000 characters)");
  });

  it("replaces the plan comment with a failure note when the plan can't run", () => {
    const md = planFailedMarkdown("Flagsmith GET https://x/api/v1/environment-document/ failed: no answer in 30 s\nmore");
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain("## FlagOps plan failed");
    expect(md).not.toContain("more");
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
    expect(md).not.toContain("### <code>Staging");
    expect(md).toContain("No changes in: <code>Staging</code>.");
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
    expect(md).toContain("- <code>banner</code>: not found in code");
    expect(md).toContain("- <code>cart</code>: <code>src/cart&#46;ts&#58;4</code>");
    expect(md).not.toContain("<code>old</code>:");
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
    expect(md).toContain("differs from the flag files in Git in **3 places**");
    expect(md).toContain("| <code>cart</code> | on, <code>10</code> | **on, <code>99</code>** | changed outside Git |");
    expect(md).toContain("| <code>gone</code> | on, <code>null</code> | **missing** | deleted outside Git |");
    expect(md).toContain("| <code>extra</code> | (not in Git) | **off, <code>null</code>** | added outside Git |");
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
