import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findReferences, formatReferences } from "./references.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "flagops-refs-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules", "lib"), { recursive: true });
  await mkdir(path.join(root, "flags"));
  await writeFile(path.join(root, "src", "checkout.ts"), 'const a = 1;\nif (flags.isEnabled("checkout_v2")) {}\n');
  await writeFile(path.join(root, "src", "theme.py"), 'dark_mode_v2 = get("dark_mode_v2")\nx = get("dark_mode")\n');
  await writeFile(path.join(root, "node_modules", "lib", "index.js"), '"checkout_v2"');
  await writeFile(path.join(root, "flags", "production.yaml"), "checkout_v2:\n  enabled: true\n");
  await writeFile(path.join(root, "logo.png"), "checkout_v2");
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("findReferences", () => {
  it("finds flags by whole word and skips dependencies, binaries and the flag files", async () => {
    const found = await findReferences(root, ["checkout_v2", "dark_mode", "unused"], ["flags"]);
    expect(found.get("checkout_v2")).toEqual([{ file: "src/checkout.ts", line: 2 }]);
    expect(found.get("dark_mode")).toEqual([{ file: "src/theme.py", line: 2 }]);
    expect(found.get("unused")).toEqual([]);
  });
});

describe("formatReferences", () => {
  it("shows the first few and how many more", () => {
    const refs = Array.from({ length: 7 }, (_, i) => ({ file: "a.ts", line: i + 1 }));
    expect(formatReferences(refs, 2)).toBe("a.ts:1, a.ts:2 (+5 more)");
    expect(formatReferences([])).toBe("not found in code");
  });
});
