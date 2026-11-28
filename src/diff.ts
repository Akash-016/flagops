// Compare what the YAML files want with what Flagsmith has now.

import { isArchived, nameProblem, type FlagEntry, type FlagFile } from "./flagfile.js";
import type { FlagValue } from "./flagsmith.js";
import { formatReferences, type Reference } from "./references.js";

export interface FlagSetting {
  enabled: boolean;
  value: FlagValue;
}

// What Flagsmith has now for one environment: flag name -> setting + the ids we need to change it.
// Archived flags are included: Flagsmith still serves them to SDKs.
export interface LiveOverride extends FlagSetting {
  segment: string;
  stateId: number;
  featureSegmentId: number;
}
export type LiveFlag = FlagSetting & { stateId: number; featureId?: number; overrides?: LiveOverride[]; multivariate?: boolean };
export type LiveFlags = Map<string, LiveFlag>;

export type Change =
  | { kind: "update"; flag: string; before: FlagSetting; after: FlagSetting; stateId: number }
  | { kind: "create"; flag: string; after: FlagSetting }
  | { kind: "untracked"; flag: string; before: FlagSetting }
  // Marked archived in YAML but missing from Flagsmith. Apply can't create an archived flag,
  // so this is only reported.
  | { kind: "archived"; flag: string; before: null; after: FlagSetting }
  // Archived on one side only. Only the Admin API can see this. Apply stops until they agree.
  | { kind: "status"; flag: string; archivedInGit: boolean }
  // A segment override to add (before null), change, or remove (after null).
  | { kind: "override"; flag: string; segment: string; before: FlagSetting | null; after: FlagSetting | null; live?: LiveOverride }
  // The order of a flag's segment overrides (first match wins).
  | { kind: "order"; flag: string; before: string[]; after: string[] }
  // YAML gives the flag an override for a segment name that matches no segment in Flagsmith
  // (renamed or deleted in the dashboard), or several. Apply skips this flag's overrides here.
  | { kind: "segment"; flag: string; segment: string; found: number };

export interface EnvironmentPlan {
  environment: string;
  changes: Change[];
}

const differ = (a: FlagSetting, b: FlagSetting) => a.enabled !== b.enabled || a.value !== b.value;
const settingOf = (s: FlagSetting): FlagSetting => ({ enabled: s.enabled, value: s.value });

// Segment overrides of one flag, for a flag whose YAML lists "segments".
// segmentCount: how many segments in Flagsmith have each name YAML uses.
function diffOverrides(flag: string, entry: FlagEntry, current: LiveFlag | undefined, segmentCount?: Map<string, number>): Change[] {
  const wanted = entry.segments ?? [];
  const live = current?.overrides ?? [];
  // A name that doesn't pick out one segment: report it, and leave this flag's overrides
  // alone until it's fixed, since the rest of the comparison would be guesswork.
  const unclear = wanted.filter((w) => segmentCount && segmentCount.get(w.segment) !== 1);
  if (unclear.length > 0) {
    return unclear.map((w) => ({ kind: "segment", flag, segment: w.segment, found: segmentCount?.get(w.segment) ?? 0 }));
  }
  const changes: Change[] = [];
  for (const w of wanted) {
    const l = live.find((o) => o.segment === w.segment);
    if (!l) changes.push({ kind: "override", flag, segment: w.segment, before: null, after: settingOf(w) });
    else if (differ(l, w)) changes.push({ kind: "override", flag, segment: w.segment, before: settingOf(l), after: settingOf(w), live: l });
  }
  for (const l of live) {
    if (!wanted.some((w) => w.segment === l.segment)) {
      changes.push({ kind: "override", flag, segment: l.segment, before: settingOf(l), after: null, live: l });
    }
  }
  // Order only matters among overrides that exist on both sides; new ones go where YAML says.
  const both = wanted.map((w) => w.segment).filter((s) => live.some((l) => l.segment === s));
  const liveBoth = live.map((l) => l.segment).filter((s) => both.includes(s));
  if (both.join("\n") !== liveBoth.join("\n")) {
    changes.push({ kind: "order", flag, before: live.map((l) => l.segment), after: wanted.map((w) => w.segment) });
  }
  return changes;
}

// archivedLive: lowercase names of flags archived in Flagsmith, when the source can tell.
export function diffEnvironment(
  wanted: FlagFile,
  live: LiveFlags,
  archivedLive?: Set<string>,
  segmentCount?: Map<string, number>,
): EnvironmentPlan {
  const changes: Change[] = [];

  for (const [flag, entry] of Object.entries(wanted.flags)) {
    const after = { enabled: entry.enabled, value: entry.value };
    const current = live.get(flag);
    const before = current ? { enabled: current.enabled, value: current.value } : null;
    if (current && archivedLive && isArchived(entry) !== archivedLive.has(flag.toLowerCase())) {
      changes.push({ kind: "status", flag, archivedInGit: isArchived(entry) });
      continue; // settle which flags are live first
    } else if (!current || !before) {
      // Flagsmith still serves archived flags, so apply keeps their settings in step like any
      // other's. It can't create one, though: that would make a live flag.
      changes.push(isArchived(entry) ? { kind: "archived", flag, before: null, after } : { kind: "create", flag, after });
    } else if (differ(before, after)) {
      changes.push({ kind: "update", flag, before, after, stateId: current.stateId });
    }
    // No "segments" key: the flag's overrides are left alone, as before FlagOps managed them.
    // An archived flag missing from Flagsmith can't be created, so neither can its overrides.
    if (entry.segments && (current || !isArchived(entry))) changes.push(...diffOverrides(flag, entry, current, segmentCount));
  }

  for (const [flag, current] of live) {
    // Names a flag file can't hold (pull skips them and says why) can't be managed or fixed in Git.
    if (!(flag in wanted.flags) && !nameProblem(flag)) {
      changes.push({ kind: "untracked", flag, before: { enabled: current.enabled, value: current.value } });
    }
  }

  changes.sort((a, b) => a.flag.localeCompare(b.flag)); // stable: a flag's own changes keep their order
  return { environment: wanted.environment, changes };
}

export const isAction = (c: Change) => c.kind === "update" || c.kind === "create" || c.kind === "override" || c.kind === "order";

// Changes that apply would actually make (the other kinds are only reported).
export function countActions(plans: EnvironmentPlan[]): number {
  return plans.reduce((n, p) => n + p.changes.filter(isAction).length, 0);
}

// Overrides apply skips because their segment name is missing or not unique in Flagsmith.
export function segmentProblems(plans: EnvironmentPlan[]): string[] {
  const seen = new Set<string>();
  for (const p of plans) {
    for (const c of p.changes) {
      if (c.kind !== "segment") continue;
      seen.add(
        c.found === 0
          ? `"${c.flag}" in ${p.environment}: segment "${c.segment}" isn't in Flagsmith (renamed or deleted?). Its overrides were left alone. Fix the name in YAML or recreate the segment.`
          : `"${c.flag}" in ${p.environment}: ${c.found} segments are named "${c.segment}". Its overrides were left alone. Rename the segments so each name is unique.`,
      );
    }
  }
  return [...seen];
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
// Production is a whole word: "Production", "prod-eu", "prd", "Live". Not "Non-Prod",
// "Preprod" or "Product Sandbox", which rank with staging.
const PROD_WORDS = ["prod", "production", "prd", "live"];
function environmentRank(name: string): number {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const negated = (i: number) => i > 0 && ["non", "pre"].includes(words[i - 1]);
  if (words.some((w, i) => PROD_WORDS.includes(w) && !negated(i))) return 2;
  if (words.some((w, i) => PROD_WORDS.includes(w) && negated(i))) return 1;
  if (/stag|qa|test|uat|preprod|nonprod/.test(words.join(" "))) return 1;
  return 0;
}

// Production-like names ("Production", "prod-eu", "live") get the warning and the reviewer note.
export const isProduction = (name: string) => environmentRank(name) === 2;

// For reading: production first, then staging, then development, each group alphabetical.
// A comment cut at GitHub's size limit then loses the least important rows.
function productionFirst<T extends { environment: string }>(plans: T[]): T[] {
  return [...plans].sort(
    (a, b) => environmentRank(b.environment) - environmentRank(a.environment) || a.environment.localeCompare(b.environment),
  );
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

// Last line of defence for anything printed, error messages included: in a GitHub Actions
// log a line starting with "::" is a workflow command, so is "##[" anywhere in a line (the
// runner's older syntax), and a lone carriage return starts a new line. Names from Flagsmith
// can hold any of these.
export const guardOutput = (s: string) =>
  s.replace(/\r(?!\n)/g, "\\r").replace(/^(\s*)::/gm, "$1: :").replace(/##\[/g, "## [");

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
      return `  ! ${flag}: archived in YAML but missing from Flagsmith (apply can't create an archived flag)`;
    case "status":
      return change.archivedInGit
        ? `  ! ${flag}: archived in YAML but not in Flagsmith (apply stops until they agree)`
        : `  ! ${flag}: archived in Flagsmith but not in YAML (apply stops until they agree)`;
    case "override": {
      const where = `${flag} [segment ${safe(change.segment)}]`;
      if (!change.before) return `  + ${where}: new override (${setting(change.after!)})`;
      if (!change.after) return `  - ${where}: override removed (was ${setting(change.before)})`;
      return `  ~ ${where}: ${setting(change.before)} -> ${setting(change.after)}`;
    }
    case "segment":
      return `  ! ${flag} [segment ${safe(change.segment)}]: ${change.found === 0 ? "no such segment in Flagsmith" : `${change.found} segments have this name`} (apply leaves this flag's overrides alone)`;
    case "order":
      return `  ~ ${flag}: segment order ${change.before.map(safe).join(", ")} -> ${change.after.map(safe).join(", ")}`;
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
  return s.replace(/[^A-Za-z0-9 ,/=?+%-]/gu, (c) => `&#${c.codePointAt(0)};${c === "@" ? "<wbr>" : ""}`);
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


function planRow(c: Change): string {
  switch (c.kind) {
    case "update":
      return `| ~ | ${code(c.flag)} | ${both(c.before)} | **${both(c.after)}** |`;
    case "create":
      return `| + | ${code(c.flag)} | (new flag) | **${both(c.after)}** |`;
    case "untracked":
      return `| ! | ${code(c.flag)} | ${both(c.before)} | not in YAML, left alone |`;
    case "archived":
      return `| ! | ${code(c.flag)} | (missing) | ${both(c.after)}: archived in YAML, can't be created |`;
    case "status":
      return c.archivedInGit
        ? `| ! | ${code(c.flag)} | not archived | archived in YAML: **apply stops** until they agree |`
        : `| ! | ${code(c.flag)} | archived | not archived in YAML: **apply stops** until they agree |`;
    case "override": {
      const mark = c.before === null ? "+" : c.after === null ? "-" : "~";
      return `| ${mark} | ${code(c.flag)} for segment ${code(c.segment)} | ${c.before ? both(c.before) : "(new override)"} | **${c.after ? both(c.after) : "override removed"}** |`;
    }
    case "order": {
      return `| ~ | ${code(c.flag)} segment order | ${c.before.map(code).join(", ")} | **${c.after.map(code).join(", ")}** |`;
    }
    case "segment":
      return `| ! | ${code(c.flag)} for segment ${code(c.segment)} | ${c.found === 0 ? "no such segment in Flagsmith" : `${c.found} segments with this name`} | apply leaves this flag's overrides alone until fixed |`;
  }
}

// A plan note for changed multivariate flags. Names are escaped: notes are Markdown.
export function multivariateNote(flags: string[]): string {
  return `Multivariate: ${flags.map(code).join(", ")}. FlagOps sets the control value; the variant weights stay as set in Flagsmith, so some users get a variant instead.`;
}

// notes: extra lines under the headline (Markdown), such as what a read-only plan can't check.
export function formatPlanMarkdown(plans: EnvironmentPlan[], refs?: Map<string, Reference[]>, notes: string[] = []): string {
  const actions = countActions(plans);
  const lines: string[] = [COMMENT_MARKER, "## FlagOps plan", ""];
  lines.push(actions === 0 ? "No flag changes." : `**${changesLabel(actions)}** will be applied when this is merged.`);
  // Counts for each environment up front, in the order changes flow.
  const changed = plans.filter((p) => p.changes.some(isAction));
  if (changed.length > 1) {
    lines.push("", changed.map((p) => `${code(p.environment)}: ${p.changes.filter(isAction).length}`).join(" · "));
  }
  for (const note of notes) lines.push("", `> ${note}`);

  // Production first (see productionFirst).
  for (const p of productionFirst(plans)) {
    if (p.changes.length === 0) continue;
    const isProd = isProduction(p.environment);
    lines.push("", `### ${code(p.environment)}${isProd ? " (production)" : ""}`, "");
    if (isProd && p.changes.some(isAction)) {
      lines.push("> [!WARNING]", "> Changes production. A reviewer must approve before they apply.", "");
    }
    lines.push("| | Flag | Before | After |", "|---|---|---|---|");
    for (const c of p.changes) lines.push(planRow(c));
  }

  const unchanged = plans.filter((p) => p.changes.length === 0).map((p) => p.environment);
  if (unchanged.length > 0 && actions > 0) lines.push("", `No changes in: ${unchanged.map(code).join(", ")}.`);
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
      return { git: `archived, ${both(c.after)}`, live: "missing", what: "deleted outside Git" };
    case "status":
      return c.archivedInGit
        ? { git: "archived", live: "not archived", what: "unarchived outside Git" }
        : { git: "not archived", live: "archived", what: "archived outside Git" };
    case "override": {
      const seg = ` for segment ${code(c.segment)}`;
      if (!c.before) return { git: `${both(c.after!)}${seg}`, live: "missing", what: "override deleted outside Git" };
      if (!c.after) return { git: "(not in Git)", live: `${both(c.before)}${seg}`, what: "override added outside Git" };
      return { git: `${both(c.after)}${seg}`, live: `${both(c.before)}${seg}`, what: "override changed outside Git" };
    }
    case "order":
      return { git: `segments ${c.after.map(code).join(", ")}`, live: `segments ${c.before.map(code).join(", ")}`, what: "segment order changed outside Git" };
    case "segment":
      return c.found === 0
        ? { git: `override for segment ${code(c.segment)}`, live: "no such segment", what: "segment renamed or deleted outside Git" }
        : { git: `override for segment ${code(c.segment)}`, live: `${c.found} segments with this name`, what: "segment name no longer unique" };
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
    `Flagsmith differs from the flag files in Git in **${total} place${total === 1 ? "" : "s"}**. ` +
      "Someone probably changed them in the Flagsmith dashboard.",
  );
  const drifted = plans.filter((p) => p.changes.length > 0);
  if (drifted.length > 1) lines.push("", drifted.map((p) => `${code(p.environment)}: ${p.changes.length}`).join(" · "));
  for (const p of productionFirst(drifted)) {
    lines.push("", `### ${code(p.environment)}`, "", "| Flag | In Git | Live in Flagsmith | |", "|---|---|---|---|");
    for (const c of p.changes) {
      const d = describeDrift(c);
      lines.push(`| ${code(c.flag)} | ${d.git} | **${d.live}** | ${d.what} |`);
    }
  }
  lines.push(
    "",
    "**To fix, pick one:**",
    "- Put Flagsmith back to what Git says: re-run the FlagOps apply workflow (or `flagops apply`). Apply never archives or unarchives a flag; do that in the dashboard.",
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
  lines.push("", `Drift found in ${total} place${total === 1 ? "" : "s"}.`);
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
