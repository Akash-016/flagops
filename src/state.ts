// Load both sides of the comparison: the YAML files and live Flagsmith.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFlagFile, type FlagFile } from "./flagfile.js";
import type { Environment, Feature, FlagsmithClient } from "./flagsmith.js";
import { diffEnvironment, type EnvironmentPlan, type LiveFlags } from "./diff.js";

export async function readFlagFiles(dir: string): Promise<FlagFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch {
    throw new Error(`Folder "${dir}" not found. Run "flagops pull" first.`);
  }
  if (names.length === 0) throw new Error(`No .yaml files in "${dir}". Run "flagops pull" first.`);

  const files: FlagFile[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const file = parseFlagFile(await readFile(path.join(dir, name), "utf8"), name);
    const key = file.environment.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`${name} and ${seen.get(key)} both describe environment "${file.environment}".`);
    }
    seen.set(key, name);
    files.push(file);
  }
  return files;
}

export async function readLiveFlags(fs: FlagsmithClient, env: Environment, features: Feature[]): Promise<LiveFlags> {
  const nameById = new Map(features.filter((f) => !f.is_archived).map((f) => [f.id, f.name]));
  const live: LiveFlags = new Map();
  for (const s of await fs.listEnvironmentStates(env.api_key)) {
    const name = nameById.get(s.feature);
    if (name) live.set(name, { enabled: s.enabled, value: s.feature_state_value ?? null, stateId: s.id });
  }
  return live;
}

export interface PlannedEnvironment extends EnvironmentPlan {
  env: Environment;
}

// Build the plan for every YAML file. Fails if a file names an environment Flagsmith doesn't have.
// onlyEnvs: if given, only these environments (by name, any case) are planned.
export async function buildPlans(
  fs: FlagsmithClient,
  projectId: number,
  dir: string,
  onlyEnvs?: string[],
): Promise<PlannedEnvironment[]> {
  const [allFiles, environments, features] = await Promise.all([
    readFlagFiles(dir),
    fs.listEnvironments(projectId),
    fs.listFeatures(projectId),
  ]);

  let files = allFiles;
  if (onlyEnvs && onlyEnvs.length > 0) {
    const wanted = onlyEnvs.map((e) => e.toLowerCase());
    files = allFiles.filter((f) => wanted.includes(f.environment.toLowerCase()));
    const missing = wanted.filter((w) => !files.some((f) => f.environment.toLowerCase() === w));
    if (missing.length > 0) throw new Error(`No flag file for environment(s): ${missing.join(", ")}`);
  }

  const plans: PlannedEnvironment[] = [];
  for (const file of files) {
    const env = environments.find((e) => e.name.toLowerCase() === file.environment.toLowerCase());
    if (!env) {
      throw new Error(
        `YAML names environment "${file.environment}", but Flagsmith only has: ${environments.map((e) => e.name).join(", ")}`,
      );
    }
    const live = await readLiveFlags(fs, env, features);
    plans.push({ ...diffEnvironment(file, live), env });
  }
  return plans;
}
