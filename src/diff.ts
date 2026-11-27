// Compare what the YAML files want with what Flagsmith has now.

import { isArchived, type FlagFile } from "./flagfile.js";
import type { FlagValue } from "./flagsmith.js";
import { formatReferences, type Reference } from "./references.js";

export interface FlagSetting {
  enabled: boolean;
  value: FlagValue;
}

// What Flagsmith has now for one environment: flag name -> setting + the id we need to change it.
// Archived flags are included: Flagsmith still serves them to SDKs.
export type LiveFlags = Map<string, FlagSetting & { stateId: number }>;

export type Change =
  | { kind: "update"; flag: string; before: FlagSetting; after: FlagSetting; stateId: number }
  | { kind: "create"; flag: string; after: FlagSetting }
  | { kind: "untracked"; flag: string; before: FlagSetting }
  // Marked archived in YAML, and Flagsmith has other settings (or no such flag). Apply leaves
  // archived flags alone, so this is only reported.
  | { kind: "archived"; flag: string; before: FlagSetting | null; after: FlagSetting }
  // Archived on one side only. Only the Admin API can see this. Apply stops until they agree.
  | { kind: "status"; flag: string; archivedInGit: boolean };

export interface EnvironmentPlan {
  environment: string;
  changes: Change[];
}

const differ = (a: FlagSetting, b: FlagSetting) => a.enabled !== b.enabled || a.value !== b.value;

// archivedLive: lowercase names of flags archived in Flagsmith, when the source can tell.
export function diffEnvironment(wanted: FlagFile, live: LiveFlags, archivedLive?: Set<string>): EnvironmentPlan {
  const changes: Change[] = [];

  for (const [flag, entry] of Object.entries(wanted.flags)) {
    const after = { enabled: entry.enabled, value: entry.value };
    const current = live.get(flag);
    const before = current ? { enabled: current.enabled, value: current.value } : null;
    if (current && archivedLive && isArchived(entry) !== archivedLive.has(flag.toLowerCase())) {
      changes.push({ kind: "status", flag, archivedInGit: isArchived(entry) });
    } else if (isArchived(entry)) {
      if (!before || differ(before, after)) changes.push({ kind: "archived", flag, before, after });
    } else if (!current || !before) {
      changes.push({ kind: "create", flag, after });
    } else if (differ(before, after)) {
      changes.push({ kind: "update", flag, before, after, stateId: current.stateId });
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

const isAction = (c: Change) => c.kind === "update" || c.kind === "create";

// Changes that apply would actually make (the other kinds are only reported).
export function countActions(plans: EnvironmentPlan[]): number {
  return plans.reduce((n, p) => n + p.changes.filter(isAction).length, 0);
}

// Flags archived on one side only: apply must not run until YAML and Flagsmith agree.
export function archiveConflicts(plans: EnvironmentPlan[]): string[] {
  const seen = new Map<string, string>();
  for (const p of plans) {
    for (const c of p.changes) {
      if (c.kind !== "status" || seen.has(c.flag)) continue;
      seen.set(
        c.flag,
        c.archivedInGit
          ? `"${c.flag}" is marked archived in YAML but isn't archived in Flagsmith. Archive it there, or remove "archived: true" from it in every flag file.`
          : `"${c.flag}" is archived in Flagsmith. Add "archived: true" to it in every flag file (flagops pull writes this), or unarchive it.`,
      );
    }
  }
  return [...seen.values()];
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

// Terminal and log output. Flag and environment names come from Flagsmith, where a name can
// hold a newline; in a GitHub Actions log, a line starting with "::" is a workflow command.
// Names with control characters are printed quoted, with the characters escaped.
export const safe = (s: string) => (/[\x00-\x1f\x7f\x85\u2028\u2029]/.test(s) ? JSON.stringify(s) : s);

const setting = (s: FlagSetting) => `${s.enabled ? "on" : "off"}, value ${show(s.value)}`;

function describe(change: Change): string {
  const flag = safe(change.flag);
  switch (change.kind) {
    case "update": {
      const parts: string[] = [];
      if (change.before.enabled !== change.after.enabled) {
        parts.push(`${change.before.enabled ? "on" : "off"} -> ${change.after.enabled ? "on" : "off"}`);
      }
      if (change.before.value !== change.after.value) {
        parts.push(`value ${show(change.before.value)} -> ${show(change.after.value)}`);
      }
      return `  ~ ${flag}: ${parts.join(", ")}`;
    }
    case "create":
      return `  + ${flag}: new flag (${setting(change.after)})`;
    case "untracked":
      return `  ! ${flag}: in Flagsmith but not in YAML (left alone)`;
    case "archived":
      return change.before
        ? `  ! ${flag}: archived; Flagsmith has ${setting(change.before)}, YAML says ${setting(change.after)} (apply leaves archived flags alone)`
        : `  ! ${flag}: archived in YAML but missing from Flagsmith`;
    case "status":
      return change.archivedInGit
        ? `  ! ${flag}: archived in YAML but not in Flagsmith (apply stops until they agree)`
        : `  ! ${flag}: archived in Flagsmith but not in YAML (apply stops until they agree)`;
  }
}

// Hidden marker so the GitHub Action can find and update its own comment instead of adding a new one.
export const COMMENT_MARKER = "<!-- flagops-plan -->";

// Flag names, values and environment names can come from the Flagsmith dashboard, so they must
// not be able to add Markdown, HTML, links or @mentions to a comment. Every character other
// than letters, digits, space and , / = ? + % - becomes an HTML entity, which GitHub shows as
// plain text. Escaping _ stops bold and italics, and escaping : and . stops URL autolinks.
// Email addresses still autolink after entities are decoded, so an invisible <wbr> follows
// every @. All of this was checked against GitHub's Markdown renderer.
export function text(s: string): string {
  return s.replace(/[^A-Za-z0-9 ,/=?+%-]/g, (c) => `&#${c.codePointAt(0)};${c === "@" ? "<wbr>" : ""}`);
}
export const code = (s: string) => `<code>${text(s)}</code>`;
const plain = (s: string) =>
  s.replace(/<\/?code>|<wbr>/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const cell = (v: FlagValue) => code(show(v));
const onOff = (enabled: boolean) => (enabled ? "on" : "off");
const both = (s: FlagSetting) => `${onOff(s.enabled)}, ${cell(s.value)}`;

// Flags that apply would change or create (the ones whose blast radius matters).
export function changedFlags(plans: EnvironmentPlan[]): string[] {
  const names = new Set<string>();
  for (const p of plans) for (const c of p.changes) if (isAction(c)) names.add(c.flag);
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

function planRow(c: Change): string {
  switch (c.kind) {
    case "update":
      return `| ~ | ${code(c.flag)} | ${both(c.before)} | **${both(c.after)}** |`;
    case "create":
      return `| + | ${code(c.flag)} | (new flag) | **${both(c.after)}** |`;
    case "untracked":
      return `| ! | ${code(c.flag)} | ${both(c.before)} | not in YAML, left alone |`;
    case "archived":
      return `| ! | ${code(c.flag)} | ${c.before ? both(c.before) : "(missing)"} | ${both(c.after)}: archived, left alone |`;
    case "status":
      return c.archivedInGit
        ? `| ! | ${code(c.flag)} | not archived | archived in YAML: **apply stops** until they agree |`
        : `| ! | ${code(c.flag)} | archived | not archived in YAML: **apply stops** until they agree |`;
  }
}

// notes: extra lines under the headline, such as what a read-only plan can't check.
export function formatPlanMarkdown(plans: EnvironmentPlan[], refs?: Map<string, Reference[]>, notes: string[] = []): string {
  const actions = countActions(plans);
  const lines: string[] = [COMMENT_MARKER, "## FlagOps plan", ""];
  lines.push(actions === 0 ? "No flag changes." : `**${changesLabel(actions)}** will be applied when this is merged.`);
  // A long comment gets cut at the end, where production is, so count each environment up front.
  const changed = plans.filter((p) => p.changes.some(isAction));
  if (changed.length > 1) {
    lines.push("", changed.map((p) => `${text(p.environment)}: ${p.changes.filter(isAction).length}`).join(" · "));
  }
  for (const note of notes) lines.push("", `> ${note}`);

  for (const p of plans) {
    if (p.changes.length === 0) continue;
    const isProd = productionNames.includes(p.environment.toLowerCase());
    lines.push("", `### ${text(p.environment)}${isProd ? " (production)" : ""}`, "");
    if (isProd && p.changes.some(isAction)) {
      lines.push("> [!WARNING]", "> Changes production. A reviewer must approve before they apply.", "");
    }
    lines.push("| | Flag | Before | After |", "|---|---|---|---|");
    for (const c of p.changes) lines.push(planRow(c));
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
      return { git: both(c.after), live: both(c.before), what: "changed outside Git" };
    case "create":
      return { git: both(c.after), live: "missing", what: "deleted outside Git" };
    case "untracked":
      return { git: "(not in Git)", live: both(c.before), what: "added outside Git" };
    case "archived":
      return c.before
        ? { git: `archived, ${both(c.after)}`, live: both(c.before), what: "archived flag changed outside Git" }
        : { git: `archived, ${both(c.after)}`, live: "missing", what: "deleted outside Git" };
    case "status":
      return c.archivedInGit
        ? { git: "archived", live: "not archived", what: "unarchived outside Git" }
        : { git: "not archived", live: "archived", what: "archived outside Git" };
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
  const drifted = plans.filter((p) => p.changes.length > 0);
  if (drifted.length > 1) lines.push("", drifted.map((p) => `${text(p.environment)}: ${p.changes.length}`).join(" · "));
  for (const p of drifted) {
    lines.push("", `### ${text(p.environment)}`, "", "| Flag | In Git | Live in Flagsmith | |", "|---|---|---|---|");
    for (const c of p.changes) {
      const d = describeDrift(c);
      lines.push(`| ${code(c.flag)} | ${d.git} | **${d.live}** | ${d.what} |`);
    }
  }
  lines.push(
    "",
    "**To fix, pick one:**",
    "- Put Flagsmith back to what Git says: re-run the FlagOps apply workflow (or `flagops apply`). Apply never changes archived flags or archive state; fix those in the dashboard.",
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
    lines.push(`${safe(p.environment)}:`);
    for (const c of p.changes) {
      const d = describeDrift(c);
      lines.push(`  ${safe(c.flag)}: Git says ${plain(d.git)}, Flagsmith has ${plain(d.live)} (${d.what})`);
    }
  }
  lines.push("", `Drift found in ${total} flag${total === 1 ? "" : "s"}.`);
  return lines.join("\n");
}

export function formatPlan(plans: EnvironmentPlan[], refs?: Map<string, Reference[]>): string {
  const lines: string[] = [];
  for (const p of plans) {
    lines.push(`${safe(p.environment)}:`);
    if (p.changes.length === 0) lines.push("  no changes");
    else lines.push(...p.changes.map(describe));
  }
  const flags = changedFlags(plans);
  if (refs && flags.length > 0) {
    lines.push("", "Used in:");
    for (const flag of flags) lines.push(`  ${safe(flag)}: ${formatReferences(refs.get(flag) ?? [])}`);
  }
  const actions = countActions(plans);
  lines.push("");
  lines.push(actions === 0 ? "Nothing to apply." : `${changesLabel(actions)} to apply.`);
  return lines.join("\n");
}
