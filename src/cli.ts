#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { getConfig } from "./config.js";
import { FlagsmithClient, type FeatureState, type Project } from "./flagsmith.js";
import { buildFlagFile, fileNameFor, toYaml } from "./flagfile.js";
import { createInterface } from "node:readline/promises";
import {
  changedFlags,
  countActions,
  countDrift,
  formatDrift,
  formatDriftMarkdown,
  formatPlan,
  formatPlanMarkdown,
} from "./diff.js";
import { findReferences } from "./references.js";
import { findStaleFlags, formatStale, formatStaleMarkdown } from "./stale.js";
import { buildPlans, readFlagFiles } from "./state.js";
import { applyPlans } from "./apply.js";

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

    await mkdir(opts.dir, { recursive: true });
    console.log(`Project ${project.name}: ${features.length} flags, ${environments.length} environments`);

    for (const env of environments) {
      const states = await fs.listEnvironmentStates(env.api_key);
      const file = buildFlagFile(env.name, features, states);
      const target = path.join(opts.dir, fileNameFor(env.name));
      await writeFile(target, toYaml(file), "utf8");
      console.log(`  wrote ${target} (${Object.keys(file.flags).length} flags)`);
    }
  });

const collect = (value: string, previous: string[] = []) => [...previous, value];

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
    const fs = client();
    const project = await resolveProject(fs, opts.project);
    const plans = await buildPlans(fs, project.id, opts.dir, opts.env);
    const refs = opts.code === false ? undefined : await findReferences(opts.code, changedFlags(plans), [opts.dir]);
    const output = opts.format === "markdown" ? formatPlanMarkdown(plans, refs) : formatPlan(plans, refs);
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
    const fs = client();
    const project = await resolveProject(fs, opts.project);
    const plans = await buildPlans(fs, project.id, opts.dir, opts.env);
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
    const plans = await buildPlans(fs, project.id, opts.dir, opts.env);
    console.log(formatPlan(plans));
    if (countActions(plans) === 0) return;

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
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
