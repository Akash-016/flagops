// The YAML file format: one file per environment.
//
//   environment: Production
//   flags:
//     popcorn_ordering:
//       enabled: false
//       value: null
//     old_banner:
//       archived: true

import { z } from "zod";
import YAML from "yaml";
import type { Feature, FeatureState, FlagValue } from "./flagsmith.js";

// Limits of what Flagsmith stores, so a value that passes here round-trips unchanged.
const MAX_INT = 2147483647;
const MAX_TEXT = 20000;

// Python's str.strip() removes these too; JavaScript's trim() leaves \x1c-\x1f and \x85.
const EDGE_SPACE = /^[\s\x1c-\x1f\x85]|[\s\x1c-\x1f\x85]$/;

const flagValue = z
  .union([z.string(), z.number(), z.boolean(), z.null()], { error: "expected text, a number, true/false or null" })
  .superRefine((v, ctx) => {
    const problem = (message: string) => ctx.addIssue({ code: "custom", message });
    if (typeof v === "number") {
      if (!Number.isInteger(v)) problem('Flagsmith stores whole numbers only; quote decimals as text, for example "1.5"');
      else if (v > MAX_INT || v < -MAX_INT - 1) problem(`number too big for Flagsmith (limit ${MAX_INT}); quote it as text`);
    } else if (typeof v === "string") {
      if ([...v].length > MAX_TEXT) problem(`text longer than ${MAX_TEXT} characters`);
      else if (EDGE_SPACE.test(v)) problem("Flagsmith trims leading and trailing spaces; remove them");
    }
  });

// A flag is either managed (enabled + value) or marked archived. Archived flags are left
// alone; the marker exists because read-only keys can't tell an archived flag from a live one.
const flagSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    value: flagValue.optional(),
    archived: z.literal(true).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.archived) {
      if (f.enabled !== undefined || f.value !== undefined) {
        ctx.addIssue({ code: "custom", message: "an archived flag has no settings; remove enabled and value" });
      }
      return;
    }
    if (f.enabled === undefined) ctx.addIssue({ code: "custom", path: ["enabled"], message: "missing (true or false)" });
    // Required: a typo such as "vaule" must not turn into null.
    if (f.value === undefined) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "missing (write value: null if the flag has no value)" });
    }
  })
  .transform((f): FlagEntry => (f.archived ? { archived: true } : { enabled: f.enabled!, value: f.value! }));

export type FlagEntry = { enabled: boolean; value: FlagValue } | { archived: true };
export const isArchived = (f: FlagEntry): f is { archived: true } => "archived" in f;

// Any name Flagsmith accepts, except control characters (names are escaped wherever
// they end up in Markdown).
const BAD_NAME = /[\x00-\x1f\x7f]/;

export const flagFileSchema = z.strictObject({
  environment: z.string().min(1),
  flags: z
    .record(z.string(), flagSchema)
    .default({})
    .superRefine((flags, ctx) => {
      const seen = new Map<string, string>();
      for (const name of Object.keys(flags)) {
        if (name === "" || BAD_NAME.test(name)) {
          ctx.addIssue({ code: "custom", path: [name], message: "flag names can't be empty or contain control characters" });
        }
        const other = seen.get(name.toLowerCase());
        if (other) ctx.addIssue({ code: "custom", path: [name], message: `same as "${other}" except for case; Flagsmith treats them as one flag` });
        seen.set(name.toLowerCase(), name);
      }
    }),
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
    if (f.is_archived) {
      flags[f.name] = { archived: true };
      continue;
    }
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
