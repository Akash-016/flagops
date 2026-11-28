// Load both sides of the comparison: the YAML files and live Flagsmith.

import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFlagFile, type FlagFile } from "./flagfile.js";
import { fromTyped, readEnvironmentDocument, type Environment, type EnvironmentDocument, type Feature, type FlagsmithClient } from "./flagsmith.js";
import { diffEnvironment, sortByEnvironment, type EnvironmentPlan, type LiveFlags, type LiveOverride } from "./diff.js";
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
    if ((await lstat(path.join(dir, name))).isSymbolicLink()) {
      throw new Error(`${name} is a symbolic link. Flag files must be regular files in "${dir}".`);
    }
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
  // Names of archived flags. Only the Admin API reports them; environment documents
  // include archived flags like any other.
  archived?(): Promise<string[]>;
  // Names of the project's segments, one entry per segment (names can repeat in Flagsmith).
  segmentNames(): Promise<string[]>;
}

const byPriority = (a: { priority: number }, b: { priority: number }) => a.priority - b.priority;

export function adminSource(fs: FlagsmithClient, projectId: number): LiveSource {
  let features: Promise<Feature[]> | undefined;
  return {
    listEnvironments: () => fs.listEnvironments(projectId),
    async readLive(env) {
      features ??= fs.listFeatures(projectId);
      // Archived flags too: Flagsmith still serves them, and environment documents include them.
      const nameById = new Map((await features).map((f) => [f.id, f.name]));
      const mv = new Set((await features).filter((f) => f.type === "MULTIVARIATE").map((f) => f.id));
      const live: LiveFlags = new Map();
      for (const s of await fs.listEnvironmentStates(env.api_key)) {
        const name = nameById.get(s.feature);
        if (name) live.set(name, { enabled: s.enabled, value: s.feature_state_value ?? null, stateId: s.id, featureId: s.feature, overrides: [], multivariate: mv.has(s.feature) });
      }
      // Segment overrides: states from one call, then segment names and priorities per flag
      // that has any (Flagsmith only lists those per flag).
      const overrides = await fs.listOverrideStates(env.id);
      for (const featureId of new Set(overrides.map((o) => o.feature))) {
        const flag = live.get(nameById.get(featureId) ?? "");
        if (!flag) continue;
        const list = [];
        for (const fseg of await fs.listFeatureSegments(env.id, featureId)) {
          const state = overrides.find((o) => o.feature === featureId && o.feature_segment === fseg.id);
          if (!state) continue;
          list.push({ segment: fseg.segment_name, enabled: state.enabled, value: fromTyped(state.feature_state_value), stateId: state.id, featureSegmentId: fseg.id, priority: fseg.priority });
        }
        flag.overrides = list.sort(byPriority).map(({ priority: _, ...o }) => o);
      }
      return live;
    },
    missing: "Flagsmith only has",
    async archived() {
      features ??= fs.listFeatures(projectId);
      return (await features).filter((f) => f.is_archived).map((f) => f.name);
    },
    segmentNames: async () => (await fs.listSegments(projectId)).map((s) => s.name),
  };
}

export function liveFromDocument(doc: EnvironmentDocument): LiveFlags {
  const live: LiveFlags = new Map();
  for (const s of doc.feature_states) {
    if (s.feature_segment) continue; // segment override, not the environment default
    live.set(s.feature.name, {
      enabled: s.enabled,
      value: s.feature_state_value ?? null,
      stateId: s.django_id,
      featureId: s.feature.id,
      overrides: [],
      multivariate: s.feature.type === "MULTIVARIATE",
    });
  }
  // Segment overrides sit under each segment, with their priority.
  const found = new Map<string, (LiveOverride & { priority: number })[]>();
  for (const seg of doc.project.segments ?? []) {
    for (const s of seg.feature_states) {
      const list = found.get(s.feature.name) ?? [];
      list.push({ segment: seg.name, enabled: s.enabled, value: s.feature_state_value ?? null, stateId: s.django_id, featureSegmentId: 0, priority: s.feature_segment?.priority ?? 0 });
      found.set(s.feature.name, list);
    }
  }
  for (const [name, list] of found) {
    const flag = live.get(name);
    if (flag) flag.overrides = list.sort(byPriority).map(({ priority: _, ...o }) => o);
  }
  return live;
}

export async function keySource(apiUrl: string, keys: string[]): Promise<LiveSource> {
  // One at a time: a small Flagsmith building several large documents at once times out.
  const docs: EnvironmentDocument[] = [];
  for (const k of keys) docs.push(await readEnvironmentDocument(apiUrl, k));
  const projects = new Set(docs.map((d) => d.project.id));
  if (projects.size > 1) {
    throw new Error(`The environment keys belong to different projects: ${[...new Set(docs.map((d) => d.project.name))].join(", ")}`);
  }
  const envs = docs.map((d) => ({ id: d.id, name: d.name, api_key: d.api_key, project: d.project.id }));
  return {
    listEnvironments: async () => envs,
    readLive: async (env) => liveFromDocument(docs.find((d) => d.id === env.id)!),
    missing: "the environment keys only cover",
    segmentNames: async () => (docs[0]?.project.segments ?? []).map((s) => s.name),
  };
}

export interface PlannedEnvironment extends EnvironmentPlan {
  env: Environment;
  featureIds: Map<string, number>; // flags in Flagsmith -> feature id, for apply
  segmentOrder: Map<string, string[]>; // flags with "segments" in YAML -> segment names in order
  multivariate: Set<string>; // multivariate flags: FlagOps sets the control value, not the weights
}

// Build the plan for every YAML file. Fails if a file names an environment the source doesn't have.
// onlyEnvs: if given, only these environments (by name, any case) are planned.
// skipEnvs: environments left out, e.g. Production for the job that applies everything else.
export async function buildPlans(source: LiveSource, dir: string, onlyEnvs?: string[], skipEnvs?: string[]): Promise<PlannedEnvironment[]> {
  const [allFiles, environments] = await Promise.all([readFlagFiles(dir), source.listEnvironments()]);

  let files = allFiles;
  if (onlyEnvs && onlyEnvs.length > 0) {
    const wanted = onlyEnvs.map((e) => e.toLowerCase());
    files = allFiles.filter((f) => wanted.includes(f.environment.toLowerCase()));
    const missing = wanted.filter((w) => !files.some((f) => f.environment.toLowerCase() === w));
    if (missing.length > 0) throw new Error(`No flag file for environment(s): ${missing.join(", ")}`);
  }
  if (skipEnvs && skipEnvs.length > 0) {
    const skip = skipEnvs.map((e) => e.toLowerCase());
    const unknown = skip.filter((w) => !allFiles.some((f) => f.environment.toLowerCase() === w));
    if (unknown.length > 0) throw new Error(`No flag file for environment(s) to skip: ${unknown.join(", ")}`);
    files = files.filter((f) => !skip.includes(f.environment.toLowerCase()));
  }

  // Only the Admin API can tell archived flags apart; with it, a flag archived on one side
  // only is reported (drift) and blocks apply. Read-only keys compare archived flags' settings.
  const archivedNames = await source.archived?.();
  const archived = archivedNames && new Set(archivedNames.map((n) => n.toLowerCase()));

  // Overrides name segments, which live in Flagsmith. A name that matches no segment (renamed or
  // deleted in the dashboard) or several is reported per flag; it doesn't stop the whole run.
  const used = new Set(files.flatMap((f) => Object.values(f.flags).flatMap((e) => (e.segments ?? []).map((o) => o.segment))));
  let segmentCount: Map<string, number> | undefined;
  if (used.size > 0) {
    const names = await source.segmentNames();
    segmentCount = new Map([...used].map((name) => [name, names.filter((n) => n === name).length]));
  }

  const plans: PlannedEnvironment[] = [];
  for (const file of files) {
    const env = environments.find((e) => e.name.toLowerCase() === file.environment.toLowerCase());
    if (!env) {
      // Report it as drift for this environment and go on with the others.
      plans.push({
        environment: file.environment,
        changes: [{ kind: "environment", flag: "", known: environments.map((e) => e.name) }],
        env: { id: -1, name: file.environment, api_key: "", project: 0 },
        featureIds: new Map(),
        segmentOrder: new Map(),
        multivariate: new Set(),
      });
      continue;
    }
    const live = await source.readLive(env);
    plans.push({
      ...diffEnvironment(file, live, archived, segmentCount),
      env,
      multivariate: new Set([...live].filter(([, l]) => l.multivariate).map(([name]) => name)),
      featureIds: new Map([...live].flatMap(([name, l]) => (l.featureId === undefined ? [] : [[name, l.featureId] as [string, number]]))),
      segmentOrder: new Map(Object.entries(file.flags).flatMap(([name, e]) => (e.segments ? [[name, e.segments.map((o) => o.segment)] as [string, string[]]] : []))),
    });
  }

  // Flagsmith rejects a new flag whose name matches an existing one in any case, archived or
  // not. Stop here, before apply changes anything, with a message that says what to do.
  const problems: string[] = [];
  for (const p of plans) {
    const liveNames = new Map(
      p.changes.filter((c) => c.kind === "untracked").map((c) => [c.flag.toLowerCase(), c.flag]),
    );
    for (const c of p.changes) {
      const other = c.kind === "create" ? liveNames.get(c.flag.toLowerCase()) : undefined;
      if (other) problems.push(`"${c.flag}" differs only in case from "${other}" in Flagsmith. Use the same spelling.`);
    }
  }
  if (problems.length > 0) throw new Error([...new Set(problems)].join("\n"));

  return sortByEnvironment(plans);
}
