// Load both sides of the comparison: the YAML files and live Flagsmith.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFlagFile, type FlagFile } from "./flagfile.js";
import { readEnvironmentDocument, type Environment, type EnvironmentDocument, type Feature, type FlagsmithClient } from "./flagsmith.js";
import { diffEnvironment, sortByEnvironment, type EnvironmentPlan, type LiveFlags } from "./diff.js";
import { checkSameFlags, type NamedFlagFile } from "./validate.js";

// Reads every flag file and runs all offline checks: schema, one file per environment,
// and the same flags in every file. Throws with every problem found.
export async function readFlagFiles(dir: string): Promise<FlagFile[]> {
  const named = await readNamedFlagFiles(dir);
  const problems = checkSameFlags(named);
  if (problems.length > 0) {
    throw new Error(`Flag files don't agree:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return named.map((n) => n.file);
}

async function readNamedFlagFiles(dir: string): Promise<NamedFlagFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch {
    throw new Error(`Folder "${dir}" not found. Run "flagops pull" first.`);
  }
  if (names.length === 0) throw new Error(`No .yaml files in "${dir}". Run "flagops pull" first.`);

  const files: NamedFlagFile[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const file = parseFlagFile(await readFile(path.join(dir, name), "utf8"), name);
    const key = file.environment.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`${name} and ${seen.get(key)} both describe environment "${file.environment}".`);
    }
    seen.set(key, name);
    files.push({ source: name, file });
  }
  return files;
}

// Where live flags come from: the Admin API (admin key), or environment documents
// (read-only server-side keys, one per environment).
export interface LiveSource {
  listEnvironments(): Promise<Environment[]>;
  readLive(env: Environment): Promise<LiveFlags>;
  // Ends the error when a flag file names an environment this source doesn't have.
  missing: string;
}

export function adminSource(fs: FlagsmithClient, projectId: number): LiveSource {
  let features: Promise<Feature[]> | undefined;
  return {
    listEnvironments: () => fs.listEnvironments(projectId),
    async readLive(env) {
      features ??= fs.listFeatures(projectId);
      const nameById = new Map((await features).filter((f) => !f.is_archived).map((f) => [f.id, f.name]));
      const live: LiveFlags = new Map();
      for (const s of await fs.listEnvironmentStates(env.api_key)) {
        const name = nameById.get(s.feature);
        if (name) live.set(name, { enabled: s.enabled, value: s.feature_state_value ?? null, stateId: s.id });
      }
      return live;
    },
    missing: "Flagsmith only has",
  };
}

export function liveFromDocument(doc: EnvironmentDocument): LiveFlags {
  const live: LiveFlags = new Map();
  for (const s of doc.feature_states) {
    if (s.feature_segment) continue; // segment override, not the environment default
    live.set(s.feature.name, { enabled: s.enabled, value: s.feature_state_value ?? null, stateId: s.django_id });
  }
  return live;
}

export async function keySource(apiUrl: string, keys: string[]): Promise<LiveSource> {
  const docs = await Promise.all(keys.map((k) => readEnvironmentDocument(apiUrl, k)));
  const projects = new Set(docs.map((d) => d.project.id));
  if (projects.size > 1) {
    throw new Error(`The environment keys belong to different projects: ${[...new Set(docs.map((d) => d.project.name))].join(", ")}`);
  }
  const envs = docs.map((d) => ({ id: d.id, name: d.name, api_key: d.api_key, project: d.project.id }));
  return {
    listEnvironments: async () => envs,
    readLive: async (env) => liveFromDocument(docs.find((d) => d.id === env.id)!),
    missing: "the environment keys only cover",
  };
}

export interface PlannedEnvironment extends EnvironmentPlan {
  env: Environment;
}

// Build the plan for every YAML file. Fails if a file names an environment the source doesn't have.
// onlyEnvs: if given, only these environments (by name, any case) are planned.
export async function buildPlans(source: LiveSource, dir: string, onlyEnvs?: string[]): Promise<PlannedEnvironment[]> {
  const [allFiles, environments] = await Promise.all([readFlagFiles(dir), source.listEnvironments()]);

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
        `YAML names environment "${file.environment}", but ${source.missing}: ${environments.map((e) => e.name).join(", ")}`,
      );
    }
    const live = await source.readLive(env);
    plans.push({ ...diffEnvironment(file, live), env });
  }
  return sortByEnvironment(plans);
}
