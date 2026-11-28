// flagops init: put the four example workflows into a repo, adjusted to its flag folder and
// production environment name, and list the GitHub settings that are left to do by hand.

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const WORKFLOWS = ["flagops-validate.yml", "flagops-plan.yml", "flagops-apply.yml", "flagops-drift.yml"];

export interface InitOptions {
  dir: string; // folder with the flag files
  production: string; // name of the production environment in Flagsmith
  force: boolean; // overwrite workflow files that already exist
}

// YAML-safe: plain words stay as they are, anything else is quoted.
const yamlValue = (s: string) => (/^[A-Za-z0-9_.-]+$/.test(s) ? s : JSON.stringify(s));

export function customize(template: string, opts: InitOptions): string {
  let s = template.replace(/^# Copy to \.github\/workflows\/ in the repo that holds your flag files\.\n/, "# Written by flagops init.\n");
  if (opts.production !== "Production") {
    s = s.replace(/^(\s+(?:skip-)?environments:) Production\b/gm, `$1 ${yamlValue(opts.production)}`);
  }
  if (opts.dir !== "flags") {
    s = s.replace(/"flags\/\*\*"/g, JSON.stringify(`${opts.dir}/**`));
    // Every FlagOps step reads the folder from its "dir" input.
    s = s.replace(/^(\s+)command: (\w+)$/gm, (_, indent: string, command: string) => `${indent}command: ${command}\n${indent}dir: ${yamlValue(opts.dir)}`);
  }
  return s;
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

export async function writeWorkflows(repoDir: string, templatesDir: string, opts: InitOptions): Promise<{ written: string[]; kept: string[] }> {
  const out = path.join(repoDir, ".github", "workflows");
  await mkdir(out, { recursive: true });
  const written: string[] = [];
  const kept: string[] = [];
  for (const name of WORKFLOWS) {
    const target = path.join(out, name);
    if (!opts.force && (await exists(target))) {
      kept.push(name);
      continue;
    }
    await writeFile(target, customize(await readFile(path.join(templatesDir, name), "utf8"), opts), "utf8");
    written.push(name);
  }
  return { written, kept };
}

// "https://github.com/o/r.git" or "git@github.com:o/r.git" -> "o/r"
export function githubRepo(remoteUrl: string): string | undefined {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())?.[1];
}

export function checklist(opts: InitOptions, repo?: string): string {
  const settings = repo ? `https://github.com/${repo}/settings` : "your repository's Settings";
  const prod = opts.production;
  return [
    "Left to do in GitHub (about 20 minutes; the README's quick start has details):",
    "",
    `1. Variable FLAGSMITH_API_URL, your Flagsmith API address (${repo ? `${settings}/variables/actions` : "Settings -> Secrets and variables -> Actions -> Variables"}):`,
    "     gh variable set FLAGSMITH_API_URL --body https://flagsmith.example.com/api/v1",
    "2. Secret FLAGSMITH_ENVIRONMENT_KEYS: one read-only server-side key per environment (Flagsmith: Environment settings -> SDK Keys), separated by spaces:",
    "     gh secret set FLAGSMITH_ENVIRONMENT_KEYS",
    `3. Environments "non-production" and "production" (${repo ? `${settings}/environments` : "Settings -> Environments"}): both limited to the main branch, each with the secret FLAGSMITH_ADMIN_KEY:`,
    "     gh secret set FLAGSMITH_ADMIN_KEY --env non-production",
    "     gh secret set FLAGSMITH_ADMIN_KEY --env production",
    `   On "production" also add Required reviewers, turn on Prevent self-review, and turn off Allow administrators to bypass.`,
    `4. A ruleset on main (${repo ? `${settings}/rules` : "Settings -> Rules"}): require a pull request, the "validate" check, and code owner review for /.github/.`,
    `5. Export your flags and commit them: flagops pull --dir ${opts.dir}`,
    "",
    `The apply workflow treats "${prod}" as production and applies every other environment first.`,
  ].join("\n");
}
