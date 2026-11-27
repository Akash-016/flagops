#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { getApiUrl, getConfig, getEnvironmentKeys } from "./config.js";
import { FlagsmithClient, type FeatureState, type Project } from "./flagsmith.js";
import { buildFlagFile, fileNameFor, flagFileSchema, toYaml, type FlagFile } from "./flagfile.js";
import { createInterface } from "node:readline/promises";
import {
  archiveConflicts,
  segmentProblems,
  changedFlags,
  guardOutput,
  countActions,
  countDrift,
  formatDrift,
  formatDriftMarkdown,
  formatPlan,
  formatPlanMarkdown,
} from "./diff.js";
import { findReferences } from "./references.js";
import { findStaleFlags, formatStale, formatStaleMarkdown } from "./stale.js";
import { adminSource, buildPlans, keySource, readFlagFiles, type LiveSource } from "./state.js";
import { applyPlans } from "./apply.js";

for (const method of ["log", "error"] as const) {
  const write = console[method];
  console[method] = (...args: unknown[]) => write(...args.map((a) => (typeof a === "string" ? guardOutput(a) : a)));
}

const program = new Command();

program
  .name("flagops")
  .description("Manage Flagsmith flags like code: every change reviewed in a pull request.");

function client(): FlagsmithClient {
  const { apiUrl, adminKey } = getConfig();
  return new FlagsmithClient(apiUrl, adminKey);
}

// Pick the project from --project (id or name), FLAGSMITH_PROJECT, or the only one there is.
async function resolveProject(fs: FlagsmithClient, wanted?: string): Promise<Project> {
  const projects = await fs.listProjects();
  const choice = wanted ?? process.env.FLAGSMITH_PROJECT;
  if (choice) {
    const match = projects.find((p) => String(p.id) === choice || p.name === choice);
    if (!match) throw new Error(`No project "${choice}". Available: ${projects.map((p) => `${p.id} (${p.name})`).join(", ")}`);
    return match;
  }
  if (projects.length === 1) return projects[0];
  if (projects.length === 0) throw new Error("This Flagsmith instance has no projects.");
  throw new Error(
    `Several projects found. Pick one with --project: ${projects.map((p) => `${p.id} (${p.name})`).join(", ")}`,
  );
}

program
  .command("check")
  .description("Check the connection to Flagsmith")
  .action(async () => {
    const projects = await client().listProjects();
    console.log(`Connected to ${getConfig().apiUrl}`);
    for (const p of projects) console.log(`  project ${p.id}: ${p.name}`);
  });

program
  .command("pull")
  .description("Export each environment's flags to <dir>/<environment>.yaml")
  .option("-p, --project <id-or-name>", "Flagsmith project")
  .option("-d, --dir <dir>", "folder for the flag files", "flags")
  .action(async (opts: { project?: string; dir: string }) => {
    const fs = client();
    const project = await resolveProject(fs, opts.project);
    const [environments, features] = await Promise.all([
      fs.listEnvironments(project.id),
      fs.listFeatures(project.id),
    ]);

    console.log(`Project ${project.name}: ${features.length} flags, ${environments.length} environments`);
    const source = adminSource(fs, project.id);
    // Overrides can only be written for segment names that pick out one segment.
    const names = await source.segmentNames();
    const segmentCount = new Map(names.map((n) => [n, names.filter((m) => m === n).length]));

    // Read everything before writing anything, so a problem never leaves half the files updated.
    const files: { target: string; file: ReturnType<typeof buildFlagFile> }[] = [];
    for (const env of environments) {
      const target = path.join(opts.dir, fileNameFor(env.name));
      const other = files.find((f) => f.target === target);
      if (other) throw new Error(`Environments "${other.file.environment}" and "${env.name}" would both be written to ${target}. Rename one in Flagsmith.`);
      const live = await source.readLive(env);
      const states = [...live].map(([, l]) => ({ id: l.stateId, feature: l.featureId!, enabled: l.enabled, feature_state_value: l.value, identity: null, feature_segment: null }));
      const overrides = new Map([...live].map(([name, l]) => [name, l.overrides ?? []]));
      files.push({ target, file: buildFlagFile(env.name, features, states, overrides, segmentCount) });
    }

    // Flagsmith accepts some names and values that validate rejects (a name with a tab, say).
    // Leave those flags out of every file, and say so, instead of writing files that won't validate.
    const skipped = new Map<string, string>();
    const noOverrides = new Map<string, string>();
    for (const { file } of files) {
      for (const [name, entry] of Object.entries(file.flags)) {
        if (entry.dropSegments) noOverrides.set(name, entry.dropSegments);
        delete entry.dropSegments;
      }
    }
    for (const { file } of files) {
      const result = flagFileSchema.safeParse(file);
      for (const issue of result.success ? [] : result.error.issues) {
        const name = issue.path[0] === "flags" && typeof issue.path[1] === "string" ? issue.path[1] : undefined;
        if (name === undefined) throw new Error(`Environment "${file.environment}": ${issue.message}`);
        if (issue.path[2] === "segments") noOverrides.set(name, issue.message);
        else if (!skipped.has(name)) skipped.set(name, issue.message);
      }
    }
    // Overrides are per environment, but whether FlagOps manages them is per flag: drop the
    // list from every file, or one environment would look like it has none.
    for (const { file } of files) {
      for (const name of skipped.keys()) delete file.flags[name];
      for (const name of noOverrides.keys()) if (file.flags[name]) delete file.flags[name].segments;
    }

    await mkdir(opts.dir, { recursive: true });
    for (const { target, file } of files) {
      await writeFile(target, toYaml(file), "utf8");
      console.log(`  wrote ${target} (${Object.keys(file.flags).length} flags)`);
    }
    for (const [name, reason] of skipped) {
      console.error(`  skipped ${JSON.stringify(name)}: ${reason}. Rename or fix it in Flagsmith to manage it here.`);
    }
    for (const [name, reason] of noOverrides) {
      console.error(`  ${JSON.stringify(name)}: segment overrides left out (${reason}); the flag's own settings were written, and its overrides stay unmanaged until that is fixed.`);
    }
  });

const collect = (value: string, previous: string[] = []) => [...previous, value];

// plan and drift only read flags: with FLAGSMITH_ENVIRONMENT_KEYS set they use those read-only
// server-side keys and never touch the admin key. Everything else needs the admin key.
async function readSource(project?: string): Promise<LiveSource> {
  const keys = getEnvironmentKeys();
  if (keys.length > 0) return keySource(getApiUrl(), keys);
  const fs = client();
  return adminSource(fs, (await resolveProject(fs, project)).id);
}

program
  .command("validate")
  .description("Check the flag files without connecting to Flagsmith (no API key needed)")
  .option("-d, --dir <dir>", "folder with the flag files", "flags")
  .action(async (opts: { dir: string }) => {
    const files = await readFlagFiles(opts.dir);
    const flags = new Set(files.flatMap((f) => Object.keys(f.flags))).size;
    console.log(`OK: ${files.length} environment file${files.length === 1 ? "" : "s"}, ${flags} flag${flags === 1 ? "" : "s"} each.`);
  });

interface PlanOptions {
  project?: string;
  dir: string;
  env?: string[];
  format: string;
  out?: string;
  code: string | false; // false when --no-code is given
}

program
  .command("plan")
  .description("Show what apply would change, without changing anything")
  .option("-p, --project <id-or-name>", "Flagsmith project")
  .option("-d, --dir <dir>", "folder with the flag files", "flags")
  .option("-e, --env <name>", "only this environment (repeat for more)", collect)
  .option("-f, --format <format>", "text or markdown", "text")
  .option("-o, --out <file>", "also write the plan to this file")
  .option("--code <dir>", "folder to search for code that uses changed flags", ".")
  .option("--no-code", "don't search the code")
  .action(async (opts: PlanOptions) => {
    if (!["text", "markdown"].includes(opts.format)) throw new Error(`--format must be text or markdown`);
    const source = await readSource(opts.project);
    const plans = await buildPlans(source, opts.dir, opts.env);
    const refs = opts.code === false ? undefined : await findReferences(opts.code, changedFlags(plans), [opts.dir]);
    const notes = source.archived
      ? []
      : ["Planned with read-only keys, which can't see whether a flag is archived. Apply checks that with the admin key and stops, changing nothing, if YAML and Flagsmith disagree."];
    const changed = new Set(changedFlags(plans));
    const mv = [...new Set(plans.flatMap((p) => [...p.multivariate].filter((f) => changed.has(f))))].sort();
    if (mv.length > 0) {
      notes.push(`Multivariate: ${mv.join(", ")}. FlagOps sets the control value; the variant weights stay as set in Flagsmith, so some users get a variant instead.`);
    }
    const output = opts.format === "markdown" ? formatPlanMarkdown(plans, refs, notes) : formatPlan(plans, refs);
    console.log(output);
    if (opts.out) await writeFile(opts.out, output, "utf8");
  });

program
  .command("drift")
  .description("Check whether Flagsmith still matches the flag files. Exit code 2 means drift.")
  .option("-p, --project <id-or-name>", "Flagsmith project")
  .option("-d, --dir <dir>", "folder with the flag files", "flags")
  .option("-e, --env <name>", "only this environment (repeat for more)", collect)
  .option("-f, --format <format>", "text or markdown", "text")
  .option("-o, --out <file>", "also write the report to this file")
  .action(async (opts: { project?: string; dir: string; env?: string[]; format: string; out?: string }) => {
    if (!["text", "markdown"].includes(opts.format)) throw new Error(`--format must be text or markdown`);
    const plans = await buildPlans(await readSource(opts.project), opts.dir, opts.env);
    const output = opts.format === "markdown" ? formatDriftMarkdown(plans) : formatDrift(plans);
    console.log(output);
    if (opts.out) await writeFile(opts.out, output, "utf8");
    if (countDrift(plans) > 0) process.exitCode = 2;
  });

program
  .command("stale")
  .description("List flags with the same setting in every environment, unchanged for N days")
  .option("-p, --project <id-or-name>", "Flagsmith project")
  .option("--days <n>", "how long a flag must be unchanged", "30")
  .option("-d, --dir <dir>", "folder with the flag files (left out of the code search)", "flags")
  .option("--code <dir>", "folder to search for code that uses the flags", ".")
  .option("--no-code", "don't search the code")
  .option("-f, --format <format>", "text or markdown", "text")
  .option("-o, --out <file>", "also write the report to this file")
  .action(async (opts: { project?: string; days: string; dir: string; code: string | false; format: string; out?: string }) => {
    if (!["text", "markdown"].includes(opts.format)) throw new Error(`--format must be text or markdown`);
    const days = Number(opts.days);
    if (!Number.isInteger(days) || days < 0) throw new Error("--days must be a whole number, 0 or more");

    const fs = client();
    const project = await resolveProject(fs, opts.project);
    const [environments, features, tags] = await Promise.all([
      fs.listEnvironments(project.id),
      fs.listFeatures(project.id),
      fs.listTags(project.id),
    ]);
    const statesByEnv = new Map<string, FeatureState[]>();
    for (const env of environments) statesByEnv.set(env.name, await fs.listEnvironmentStates(env.api_key));

    const stale = findStaleFlags(features, statesByEnv, tags, days);
    const refs = opts.code === false ? undefined : await findReferences(opts.code, stale.map((s) => s.name), [opts.dir]);
    const output = opts.format === "markdown" ? formatStaleMarkdown(stale, days, refs) : formatStale(stale, days, refs);
    console.log(output);
    if (opts.out) await writeFile(opts.out, output, "utf8");
  });

program
  .command("apply")
  .description("Make Flagsmith match the YAML files (never deletes flags)")
  .option("-p, --project <id-or-name>", "Flagsmith project")
  .option("-d, --dir <dir>", "folder with the flag files", "flags")
  .option("-e, --env <name>", "only this environment (repeat for more)", collect)
  .option("-y, --yes", "don't ask for confirmation (for CI)")
  .action(async (opts: { project?: string; dir: string; env?: string[]; yes?: boolean }) => {
    const fs = client();
    const project = await resolveProject(fs, opts.project);
    const plans = await buildPlans(adminSource(fs, project.id), opts.dir, opts.env);
    const conflicts = archiveConflicts(plans);
    if (conflicts.length > 0) {
      // Show the plan without its "N changes to apply" line: none will be.
      console.log(formatPlan(plans).replace(/\n\n[^\n]*$/, ""));
      throw new Error(`\nApply stopped; nothing changed:\n${conflicts.join("\n")}`);
    }
    console.log(formatPlan(plans));
    if (countActions(plans) === 0) {
      const skipped = segmentProblems(plans);
      if (skipped.length > 0) throw new Error(`Skipped, fix and run again:\n${skipped.map((s) => `  ${s}`).join("\n")}`);
      return;
    }

    if (!opts.yes) {
      if (!process.stdin.isTTY) throw new Error("Not asking for confirmation without a terminal. Use --yes.");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("\nApply these changes? (y/n) ");
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        console.log("Nothing changed.");
        return;
      }
    }

    const result = await applyPlans(fs, project.id, plans);
    console.log("");
    for (const line of result.applied) console.log(`  done   ${line}`);
    if (result.failed) {
      console.error(`  FAILED ${result.failed.what}\n         ${result.failed.error}`);
      console.error(`\nStopped after ${result.applied.length} change(s). Run "flagops plan" to see what is left.`);
      process.exit(1);
    }
    console.log(`\nApplied ${result.applied.length} change(s).`);
    if (result.skipped) {
      console.error(`\nSkipped, fix and run again:\n${result.skipped.map((s) => `  ${s}`).join("\n")}`);
      process.exit(1);
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
