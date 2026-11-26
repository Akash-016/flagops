// The YAML file format: one file per environment.
//
//   environment: Production
//   flags:
//     popcorn_ordering:
//       enabled: false
//       value: null

import { z } from "zod";
import YAML from "yaml";
import type { Feature, FeatureState } from "./flagsmith.js";

const flagSchema = z.object({
  enabled: z.boolean(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).default(null),
});

export const flagFileSchema = z.object({
  environment: z.string().min(1),
  flags: z.record(z.string(), flagSchema).default({}),
});

export type FlagFile = z.infer<typeof flagFileSchema>;

// File name for an environment: "Production" -> "production.yaml".
export function fileNameFor(environmentName: string): string {
  return environmentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".yaml";
}

// Turn Flagsmith's features + states into our file shape, sorted by flag name
// so the same flags always produce the same file (clean diffs in pull requests).
export function buildFlagFile(environmentName: string, features: Feature[], states: FeatureState[]): FlagFile {
  const stateByFeature = new Map(states.map((s) => [s.feature, s]));
  const flags: FlagFile["flags"] = {};
  for (const f of [...features].sort((a, b) => a.name.localeCompare(b.name))) {
    if (f.is_archived) continue;
    const state = stateByFeature.get(f.id);
    if (!state) continue;
    flags[f.name] = { enabled: state.enabled, value: state.feature_state_value ?? null };
  }
  return { environment: environmentName, flags };
}

export function toYaml(file: FlagFile): string {
  return YAML.stringify(file);
}

export function parseFlagFile(text: string, source: string): FlagFile {
  const result = flagFileSchema.safeParse(YAML.parse(text));
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join(".") || "(top)"}: ${i.message}`).join("\n");
    throw new Error(`${source} is not a valid flag file:\n${problems}`);
  }
  return result.data;
}
