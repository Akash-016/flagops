// Compare what the YAML files want with what Flagsmith has now.

import type { FlagFile } from "./flagfile.js";
import type { FlagValue } from "./flagsmith.js";

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

const cell = (v: FlagValue) => "`" + show(v).replace(/\|/g, "\\|") + "`";
const onOff = (enabled: boolean) => (enabled ? "on" : "off");

export function formatPlanMarkdown(plans: EnvironmentPlan[], productionNames: string[] = ["production"]): string {
  const actions = countActions(plans);
  const lines: string[] = [COMMENT_MARKER, "## FlagOps plan", ""];
  lines.push(actions === 0 ? "No flag changes." : `**${changesLabel(actions)}** will be applied when this is merged.`);

  for (const p of plans) {
    if (p.changes.length === 0) continue;
    const isProd = productionNames.includes(p.environment.toLowerCase());
    lines.push("", `### ${p.environment}${isProd ? " (production)" : ""}`, "");
    if (isProd && p.changes.some((c) => c.kind !== "untracked")) {
      lines.push("> [!WARNING]", "> Changes production. A reviewer must approve before they apply.", "");
    }
    lines.push("| | Flag | Before | After |", "|---|---|---|---|");
    for (const c of p.changes) {
      if (c.kind === "update") {
        lines.push(`| ~ | \`${c.flag}\` | ${onOff(c.before.enabled)}, ${cell(c.before.value)} | **${onOff(c.after.enabled)}, ${cell(c.after.value)}** |`);
      } else if (c.kind === "create") {
        lines.push(`| + | \`${c.flag}\` | (new flag) | **${onOff(c.after.enabled)}, ${cell(c.after.value)}** |`);
      } else {
        lines.push(`| ! | \`${c.flag}\` | ${onOff(c.before.enabled)}, ${cell(c.before.value)} | not in YAML, left alone |`);
      }
    }
  }

  const unchanged = plans.filter((p) => p.changes.length === 0).map((p) => p.environment);
  if (unchanged.length > 0 && actions > 0) lines.push("", `No changes in: ${unchanged.join(", ")}.`);
  return lines.join("\n") + "\n";
}

export function formatPlan(plans: EnvironmentPlan[]): string {
  const lines: string[] = [];
  for (const p of plans) {
    lines.push(`${p.environment}:`);
    if (p.changes.length === 0) lines.push("  no changes");
    else lines.push(...p.changes.map(describe));
  }
  const actions = countActions(plans);
  lines.push("");
  lines.push(actions === 0 ? "Nothing to apply." : `${changesLabel(actions)} to apply.`);
  return lines.join("\n");
}
