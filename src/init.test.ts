import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { checklist, customize, githubRepo, WORKFLOWS, writeRepoFiles, writeWorkflows } from "./init.js";

const templates = path.resolve(import.meta.dirname, "..", "examples", "workflows");
const opts = { dir: "flags", production: "Production", force: false };

describe("flagops init", () => {
  it("writes the four example workflows, and keeps existing ones unless forced", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "flagops-init-"));
    mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(repo, ".github", "workflows", "flagops-plan.yml"), "mine\n");
    const first = await writeWorkflows(repo, templates, opts);
    expect(first.kept).toEqual(["flagops-plan.yml"]);
    expect(first.written).toHaveLength(3);
    expect(readFileSync(path.join(repo, ".github", "workflows", "flagops-plan.yml"), "utf8")).toBe("mine\n");
    const forced = await writeWorkflows(repo, templates, { ...opts, force: true });
    expect(forced.written).toEqual(WORKFLOWS);
  });

  it("adjusts the flag folder and production name, and the result is still valid YAML", () => {
    const apply = readFileSync(path.join(templates, "flagops-apply.yml"), "utf8");
    const out = customize(apply, { dir: "config/flags", production: "Prod EU", force: false });
    expect(out).toContain('environments: "Prod EU"');
    expect(out).toContain("environments: Development, Staging");
    expect(out).toContain('allow-production: "false"');
    expect(out).toContain('- "config/flags/**"');
    expect(out).not.toMatch(/environments: Production\b/);
    const workflow = YAML.parse(out);
    const steps = workflow.jobs["apply-non-production"].steps.filter((s: { with?: { command?: string } }) => s.with?.command);
    expect(steps.every((s: { with: { dir?: string } }) => s.with.dir === "config/flags")).toBe(true);
    expect(customize(apply, opts)).toContain("# Written by flagops init.");
  });

  it("takes $ in names literally", () => {
    const apply = readFileSync(path.join(templates, "flagops-apply.yml"), "utf8");
    const out = customize(apply, { dir: "a$1b", production: "Prod$1x", force: false });
    expect(out).toContain('environments: "Prod$1x"');
    expect(out).toContain('- "a$1b/**"');
    expect(() => YAML.parse(out)).not.toThrow();
  });

  it("writes CODEOWNERS for .github/ and keeps .env out of Git, once", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "flagops-init-"));
    writeFileSync(path.join(repo, ".gitignore"), "node_modules");
    expect(await writeRepoFiles(repo, "someone")).toEqual([".github/CODEOWNERS", ".gitignore (.env)"]);
    expect(readFileSync(path.join(repo, ".github", "CODEOWNERS"), "utf8")).toContain("/.github/ @someone");
    expect(readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe("node_modules\n.env\n");
    expect(await writeRepoFiles(repo, "someone")).toEqual([]);
  });

  it("reads the repository from a git remote and links its settings", () => {
    expect(githubRepo("https://github.com/someone/shop.git")).toBe("someone/shop");
    expect(githubRepo("git@github.com:someone/shop.git")).toBe("someone/shop");
    expect(githubRepo("https://gitlab.com/someone/shop.git")).toBeUndefined();
    expect(checklist(opts, "someone/shop")).toContain("https://github.com/someone/shop/settings/environments");
    expect(checklist(opts)).toContain("Settings -> Environments");
  });
});
