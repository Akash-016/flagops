// Stale flags: same setting in every environment and unchanged for a while.
// Such a flag no longer controls anything, so it and its dead code path can go.

import type { Feature, FeatureState, FlagValue, Tag } from "./flagsmith.js";
import type { Reference } from "./references.js";

export const PERMANENT_TAG = "permanent";

export interface StaleFlag {
  name: string;
  enabled: boolean; // on everywhere (true) or off everywhere (false)
  value: FlagValue;
  lastChanged: Date;
  daysUnchanged: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// statesByEnv: environment name -> that environment's flag states.
export function findStaleFlags(
  features: Feature[],
  statesByEnv: Map<string, FeatureState[]>,
  tags: Tag[],
  days: number,
  now: Date = new Date(),
): StaleFlag[] {
  const permanentIds = new Set(tags.filter((t) => t.label.toLowerCase() === PERMANENT_TAG).map((t) => t.id));
  const stale: StaleFlag[] = [];

  for (const f of features) {
    if (f.is_archived || (f.tags ?? []).some((t) => permanentIds.has(t))) continue;

    const states = [...statesByEnv.values()].map((list) => list.find((s) => s.feature === f.id));
    if (states.length === 0 || states.some((s) => s === undefined)) continue;
    const all = states as FeatureState[];

    const first = all[0];
    const same = all.every((s) => s.enabled === first.enabled && (s.feature_state_value ?? null) === (first.feature_state_value ?? null));
    if (!same) continue;

    const times = all.map((s) => Date.parse(s.updated_at ?? f.created_date ?? "")).filter((t) => !Number.isNaN(t));
    if (times.length === 0) continue;
    const lastChanged = new Date(Math.max(...times));
    const daysUnchanged = Math.floor((now.getTime() - lastChanged.getTime()) / DAY_MS);
    if (daysUnchanged < days) continue;

    stale.push({ name: f.name, enabled: first.enabled, value: first.feature_state_value ?? null, lastChanged, daysUnchanged });
  }
  return stale.sort((a, b) => b.daysUnchanged - a.daysUnchanged || a.name.localeCompare(b.name));
}

const advice = (s: StaleFlag) =>
  s.enabled
    ? "on everywhere: remove the flag and keep the code path it turns on"
    : "off everywhere: remove the flag and the code behind it";

const ageText = (d: number) => (d === 0 ? "changed today" : `unchanged for ${d} day${d === 1 ? "" : "s"}`);

function refsText(refs: Reference[] | undefined, max = 5): string {
  if (!refs) return "";
  if (refs.length === 0) return "not found in code";
  const shown = refs.slice(0, max).map((r) => `${r.file}:${r.line}`).join(", ");
  return shown + (refs.length > max ? ` (+${refs.length - max} more)` : "");
}

export function formatStale(stale: StaleFlag[], days: number, refs?: Map<string, Reference[]>): string {
  if (stale.length === 0) return `No stale flags (same in every environment and unchanged for ${days}+ days).`;
  const lines = [`${stale.length} stale flag${stale.length === 1 ? "" : "s"}:`, ""];
  for (const s of stale) {
    lines.push(`  ${s.name}: ${advice(s)} (${ageText(s.daysUnchanged)})`);
    if (refs) lines.push(`    used in: ${refsText(refs.get(s.name))}`);
  }
  lines.push("", `Tag a flag "${PERMANENT_TAG}" in Flagsmith to leave it out (for example a kill switch).`);
  return lines.join("\n");
}

export function formatStaleMarkdown(stale: StaleFlag[], days: number, refs?: Map<string, Reference[]>): string {
  const lines = ["## Stale flags", ""];
  if (stale.length === 0) {
    lines.push(`No stale flags (same in every environment and unchanged for ${days}+ days).`);
    return lines.join("\n") + "\n";
  }
  lines.push(
    `**${stale.length} flag${stale.length === 1 ? "" : "s"}** have had the same setting in every environment for ${days}+ days.`,
    "",
    `| Flag | Setting everywhere | Unchanged | What to do |${refs ? " Used in |" : ""}`,
    `|---|---|---|---|${refs ? "---|" : ""}`,
  );
  for (const s of stale) {
    const setting = `${s.enabled ? "on" : "off"}${s.value === null ? "" : `, \`${JSON.stringify(s.value)}\``}`;
    const todo = s.enabled ? "Remove flag, keep the code it turns on" : "Remove flag and the code behind it";
    lines.push(`| \`${s.name}\` | ${setting} | ${s.daysUnchanged} days | ${todo} |${refs ? ` ${refsText(refs.get(s.name))} |` : ""}`);
  }
  lines.push("", `Tag a flag \`${PERMANENT_TAG}\` in Flagsmith to leave it out (for example a kill switch).`);
  return lines.join("\n") + "\n";
}
