// The YAML file format: one file per environment.
//
//   environment: Production
//   flags:
//     popcorn_ordering:
//       enabled: false
//       value: null
//     old_banner:
//       archived: true
//       enabled: false
//       value: null

import { z } from "zod";
import YAML from "yaml";
import type { Feature, FeatureState, FlagValue } from "./flagsmith.js";

// Limits of what Flagsmith stores, so a value that passes here round-trips unchanged.
const MAX_INT = 2147483647;
const MAX_TEXT = 20000;
const MAX_NAME = 2000;

// The characters Python's str.strip() removes, which is how Flagsmith trims names and text
// values. Not the same as JavaScript's \s: Python also strips \x1c-\x1f and \x85, but keeps U+FEFF.
const EDGE_SPACE =
  /^[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;

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

// archived: true marks a flag archived in Flagsmith. Flagsmith still serves archived flags to
// SDKs, so their settings stay in YAML and drift checks them, but apply never changes them.
// A segment override: the flag's setting for users in that segment. Segments themselves
// (their rules) are managed in Flagsmith; YAML refers to them by name.
const overrideSchema = z.strictObject({
  segment: z.string().min(1, "segment name missing"),
  enabled: z.boolean({ error: "missing (true or false)" }),
  value: flagValue,
});

const flagSchema = z
  .strictObject({
    archived: z.literal(true).optional(),
    enabled: z.boolean().optional(),
    value: flagValue.optional(),
    // In priority order: the first segment a user matches wins. Leave the key out to leave
    // the flag's overrides alone; write [] to have none.
    segments: z.array(overrideSchema).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.enabled === undefined) ctx.addIssue({ code: "custom", path: ["enabled"], message: "missing (true or false)" });
    // Required: a typo such as "vaule" must not turn into null.
    if (f.value === undefined) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "missing (write value: null if the flag has no value)" });
    }
    const seen = new Set<string>();
    f.segments?.forEach((o, i) => {
      if (seen.has(o.segment)) ctx.addIssue({ code: "custom", path: ["segments", i, "segment"], message: `"${o.segment}" is listed twice` });
      seen.add(o.segment);
    });
  })
  .transform((f): FlagEntry => ({
    ...(f.archived ? { archived: true as const } : {}),
    enabled: f.enabled!,
    value: f.value!,
    ...(f.segments ? { segments: f.segments } : {}),
  }));

export interface SegmentOverride {
  segment: string;
  enabled: boolean;
  value: FlagValue;
}
export type FlagEntry = { enabled: boolean; value: FlagValue; archived?: true; segments?: SegmentOverride[] };
export const isArchived = (f: FlagEntry): boolean => f.archived === true;

// Any name Flagsmith accepts and stores unchanged: no control characters, no leading or
// trailing spaces (Flagsmith would trim them), at most 2000 characters.
const BAD_NAME = /[\x00-\x1f\x7f]/;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/;

export function nameProblem(name: string): string | undefined {
  if (name === "" || BAD_NAME.test(name)) return "flag names can't be empty or contain control characters";
  if (BIDI.test(name)) return "flag names can't contain text-direction characters (they can make one name look like another)";
  if (INVISIBLE.test(name)) return "flag names can't contain invisible characters (they can make one name look like another)";
  if (name === "__proto__") return "a flag can't be named __proto__ (a JavaScript object can't hold that key)";
  if (EDGE_SPACE.test(name)) return "Flagsmith trims leading and trailing spaces from flag names; remove them";
  if ([...name].length > MAX_NAME) return `flag names can be at most ${MAX_NAME} characters`;
  return undefined;
}

export const flagFileSchema = z.strictObject({
  environment: z.string().min(1),
  flags: z
    .preprocess((v) => (v === null ? {} : v), z.record(z.string(), flagSchema))
    .default({})
    .superRefine((flags, ctx) => {
      const seen = new Map<string, string>();
      for (const name of Object.keys(flags)) {
        const problem = nameProblem(name);
        if (problem) ctx.addIssue({ code: "custom", path: [name], message: problem });
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
// overrides: each flag's segment overrides in priority order. When given, every flag gets a
// "segments" list (empty if it has none), so FlagOps manages them all from then on.
// segmentCount: how many segments have each name. A flag with an override for a segment whose
// name isn't unique gets no "segments" list (and a dropSegments reason for pull to report).
export function buildFlagFile(
  environmentName: string,
  features: Feature[],
  states: FeatureState[],
  overrides?: Map<string, SegmentOverride[]>,
  segmentCount?: Map<string, number>,
): FlagFile & { flags: Record<string, FlagEntry & { dropSegments?: string }> } {
  const stateByFeature = new Map(states.map((s) => [s.feature, s]));
  const flags: FlagFile["flags"] = {};
  for (const f of [...features].sort((a, b) => a.name.localeCompare(b.name))) {
    const state = stateByFeature.get(f.id);
    if (!state || f.name === "__proto__") continue; // pull reports it as skipped
    const entry: FlagEntry = { enabled: state.enabled, value: state.feature_state_value ?? null };
    const list = overrides?.get(f.name) ?? [];
    const unclear = list.find((o) => (segmentCount?.get(o.segment) ?? 1) !== 1);
    if (unclear) {
      (entry as { dropSegments?: string }).dropSegments = `${segmentCount?.get(unclear.segment)} segments are named "${unclear.segment}"`;
    } else if (overrides) {
      entry.segments = list.map((o) => ({ segment: o.segment, enabled: o.enabled, value: o.value }));
    }
    flags[f.name] = f.is_archived ? { archived: true, ...entry } : entry;
  }
  return { environment: environmentName, flags };
}

export function toYaml(file: FlagFile): string {
  return YAML.stringify(file);
}

export function parseFlagFile(text: string, source: string): FlagFile {
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  const rawFlags = (data as { flags?: unknown } | null)?.flags;
  if (rawFlags && typeof rawFlags === "object" && Object.hasOwn(rawFlags, "__proto__")) {
    throw new Error(`${source} is not a valid flag file:\n  flags.__proto__: a flag can't be named __proto__ (a JavaScript object can't hold that key)`);
  }
  const result = flagFileSchema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join(".") || "(top)"}: ${i.message}`).join("\n");
    throw new Error(`${source} is not a valid flag file:\n${problems}`);
  }
  return result.data;
}
