// Compare what the YAML files want with what Flagsmith has now.

import { isArchived, type FlagFile } from "./flagfile.js";
import type { FlagValue } from "./flagsmith.js";
import { formatReferences, type Reference } from "./references.js";

export interface FlagSetting {
  enabled: boolean;
  value: FlagValue;
}

// What Flagsmith has now for one environment: flag name -> setting + the id we need to change it.
export type LiveFlags = Map<string, FlagSetting & { stateId: number }>;

export type Change =
  | { kind: "update"; flag: string; before: FlagSetting; after: FlagSetting; stateId: number }
  | { kind: "create"; flag: string; after: FlagSetting }
  | { kind: "untracked"; flag: string; before: FlagSetting };

export interface EnvironmentPlan {
  environment: string;
  changes: Change[];
}

export function diffEnvironment(wanted: FlagFile, live: LiveFlags): EnvironmentPlan {
  const changes: Change[] = [];

  for (const [flag, after] of Object.entries(wanted.flags)) {
    if (isArchived(after)) continue; // archived flags are left alone, and not reported as untracked below
    const current = live.get(flag);
    if (!current) {
      changes.push({ kind: "create", flag, after });
    } else if (current.enabled !== after.enabled || current.value !== after.value) {
      changes.push({
        kind: "update",
        flag,
        before: { enabled: current.enabled, value: current.value },
        after,
        stateId: current.stateId,
      });
    }
  }

  for (const [flag, current] of live) {
    if (!(flag in wanted.flags)) {
      changes.push({ kind: "untracked", flag, before: { enabled: current.enabled, value: current.value } });
    }
  }

  changes.sort((a, b) => a.flag.localeCompare(b.flag));
  return { environment: wanted.environment, changes };
}

// Changes that apply would actually make (untracked flags are only warnings).
export function countActions(plans: EnvironmentPlan[]): number {
  return plans.reduce((n, p) => n + p.changes.filter((c) => c.kind !== "untracked").length, 0);
}

const changesLabel = (n: number) => `${n} change${n === 1 ? "" : "s"}`;

// Order environments the way changes flow: development first, then staging, production last.
function environmentRank(name: string): number {
  const n = name.toLowerCase();
  if (n.includes("prod") || n === "live") return 2;
  if (n.includes("stag") || n.includes("qa") || n.includes("test") || n.includes("uat")) return 1;
  return 0;
}

export function sortByEnvironment<T extends { environment: string }>(plans: T[]): T[] {
  return [...plans].sort(
    (a, b) => environmentRank(a.environment) - environmentRank(b.environment) || a.environment.localeCompare(b.environment),
  );
}

const show = (v: FlagValue) => (v === null ? "null" : JSON.stringify(v));

function describe(change: Change): string {
  switch (change.kind) {
    case "update": {
      const parts: string[] = [];
      if (change.before.enabled !== change.after.enabled) {
        parts.push(`${change.before.enabled ? "on" : "off"} -> ${change.after.enabled ? "on" : "off"}`);
      }
      if (change.before.value !== change.after.value) {
        parts.push(`value ${show(change.before.value)} -> ${show(change.after.value)}`);
      }
      return `  ~ ${change.flag}: ${parts.join(", ")}`;
    }
    case "create":
      return `  + ${change.flag}: new flag (${change.after.enabled ? "on" : "off"}, value ${show(change.after.value)})`;
    case "untracked":
      return `  ! ${change.flag}: in Flagsmith but not in YAML (left alone)`;
  }
}

// Hidden marker so the GitHub Action can find and update its own comment instead of adding a new one.
export const COMMENT_MARKER = "<!-- flagops-plan -->";

// Flag names, values and environment names can come from the Flagsmith dashboard, so they must
// not be able to add Markdown, HTML or @mentions to a comment. Every character other than
// letters, digits, space and _ . - , : / = ? + % becomes an HTML entity, which GitHub
// shows as plain text. (Those few are left alone so URLs don't triple in length.)
export function text(s: string): string {
  return s.replace(/[^A-Za-z0-9 _.,:/=?+%-]/g, (c) => `&#${c.codePointAt(0)};`);
}
export const code = (s: string) => `<code>${text(s)}</code>`;
const plain = (s: string) => s.replace(/<\/?code>/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const cell = (v: FlagValue) => code(show(v));
const onOff = (enabled: boolean) => (enabled ? "on" : "off");

// Flags that apply would change or create (the ones whose blast radius matters).
export function changedFlags(plans: EnvironmentPlan[]): string[] {
  const names = new Set<string>();
  for (const p of plans) for (const c of p.changes) if (c.kind !== "untracked") names.add(c.flag);
  return [...names].sort();
}

function referencesMarkdown(plans: EnvironmentPlan[], refs?: Map<string, Reference[]>): string[] {
  const flags = changedFlags(plans);
  if (!refs || flags.length === 0) return [];
  const lines = ["", "### Where these flags are used", ""];
  const max = 5;
  for (const flag of flags) {
    const found = refs.get(flag) ?? [];
    let where = "not found in code";
    if (found.length > 0) {
      where = found.slice(0, max).map((r) => code(`${r.file}:${r.line}`)).join(", ");
      if (found.length > max) where += ` (+${found.length - max} more)`;
    }
    lines.push(`- ${code(flag)}: ${where}`);
  }
  return lines;
}

const productionNames = ["production"];

export function formatPlanMarkdown(plans: EnvironmentPlan[], refs?: Map<string, Reference[]>): string {
  const actions = countActions(plans);
  const lines: string[] = [COMMENT_MARKER, "## FlagOps plan", ""];
  lines.push(actions === 0 ? "No flag changes." : `**${changesLabel(actions)}** will be applied when this is merged.`);

  for (const p of plans) {
    if (p.changes.length === 0) continue;
    const isProd = productionNames.includes(p.environment.toLowerCase());
    lines.push("", `### ${text(p.environment)}${isProd ? " (production)" : ""}`, "");
    if (isProd && p.changes.some((c) => c.kind !== "untracked")) {
      lines.push("> [!WARNING]", "> Changes production. A reviewer must approve before they apply.", "");
    }
    lines.push("| | Flag | Before | After |", "|---|---|---|---|");
    for (const c of p.changes) {
      if (c.kind === "update") {
        lines.push(`| ~ | ${code(c.flag)} | ${onOff(c.before.enabled)}, ${cell(c.before.value)} | **${onOff(c.after.enabled)}, ${cell(c.after.value)}** |`);
      } else if (c.kind === "create") {
        lines.push(`| + | ${code(c.flag)} | (new flag) | **${onOff(c.after.enabled)}, ${cell(c.after.value)}** |`);
      } else {
        lines.push(`| ! | ${code(c.flag)} | ${onOff(c.before.enabled)}, ${cell(c.before.value)} | not in YAML, left alone |`);
      }
    }
  }

  const unchanged = plans.filter((p) => p.changes.length === 0).map((p) => p.environment);
  if (unchanged.length > 0 && actions > 0) lines.push("", `No changes in: ${unchanged.map(text).join(", ")}.`);
  lines.push(...referencesMarkdown(plans, refs));
  return lines.join("\n") + "\n";
}

// --- Drift: the same comparison, described from the other side. Git is the truth;
// anything different in Flagsmith was changed outside Git (usually in the dashboard).

export const DRIFT_MARKER = "<!-- flagops-drift -->";

export function countDrift(plans: EnvironmentPlan[]): number {
  return plans.reduce((n, p) => n + p.changes.length, 0);
}

function describeDrift(c: Change): { git: string; live: string; what: string } {
  switch (c.kind) {
    case "update":
      return {
        git: `${onOff(c.after.enabled)}, ${cell(c.after.value)}`,
        live: `${onOff(c.before.enabled)}, ${cell(c.before.value)}`,
        what: "changed outside Git",
      };
    case "create":
      return { git: `${onOff(c.after.enabled)}, ${cell(c.after.value)}`, live: "missing", what: "deleted outside Git" };
    case "untracked":
      return { git: "(not in Git)", live: `${onOff(c.before.enabled)}, ${cell(c.before.value)}`, what: "added outside Git" };
  }
}

export function formatDriftMarkdown(plans: EnvironmentPlan[]): string {
  const total = countDrift(plans);
  const lines: string[] = [DRIFT_MARKER];
  if (total === 0) {
    lines.push("## No flag drift", "", "Flagsmith matches the flag files in Git.");
    return lines.join("\n") + "\n";
  }
  lines.push(
    "## Flag drift detected",
    "",
    `**${total} flag${total === 1 ? "" : "s"}** in Flagsmith no longer ${total === 1 ? "matches" : "match"} the flag files in Git. ` +
      "Someone probably changed them in the Flagsmith dashboard.",
  );
  for (const p of plans) {
    if (p.changes.length === 0) continue;
    lines.push("", `### ${text(p.environment)}`, "", "| Flag | In Git | Live in Flagsmith | |", "|---|---|---|---|");
    for (const c of p.changes) {
      const d = describeDrift(c);
      lines.push(`| ${code(c.flag)} | ${d.git} | **${d.live}** | ${d.what} |`);
    }
  }
  lines.push(
    "",
    "**To fix, pick one:**",
    "- Put Flagsmith back to what Git says: re-run the FlagOps apply workflow (or `flagops apply`).",
    "- Keep the dashboard change: run `flagops pull` and open a pull request with the updated files.",
    "",
    "This issue closes itself once Flagsmith and Git match again.",
  );
  return lines.join("\n") + "\n";
}

export function formatDrift(plans: EnvironmentPlan[]): string {
  const total = countDrift(plans);
  if (total === 0) return "No drift: Flagsmith matches the flag files.";
  const lines: string[] = [];
  for (const p of plans) {
    if (p.changes.length === 0) continue;
    lines.push(`${p.environment}:`);
    for (const c of p.changes) {
      const d = describeDrift(c);
      lines.push(`  ${c.flag}: Git says ${plain(d.git)}, Flagsmith has ${plain(d.live)} (${d.what})`);
    }
  }
  lines.push("", `Drift found in ${total} flag${total === 1 ? "" : "s"}.`);
  return lines.join("\n");
}

export function formatPlan(plans: EnvironmentPlan[], refs?: Map<string, Reference[]>): string {
  const lines: string[] = [];
  for (const p of plans) {
    lines.push(`${p.environment}:`);
    if (p.changes.length === 0) lines.push("  no changes");
    else lines.push(...p.changes.map(describe));
  }
  const flags = changedFlags(plans);
  if (refs && flags.length > 0) {
    lines.push("", "Used in:");
    for (const flag of flags) lines.push(`  ${flag}: ${formatReferences(refs.get(flag) ?? [])}`);
  }
  const actions = countActions(plans);
  lines.push("");
  lines.push(actions === 0 ? "Nothing to apply." : `${changesLabel(actions)} to apply.`);
  return lines.join("\n");
}
