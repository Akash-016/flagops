#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { getConfig } from "./config.js";
import { FlagsmithClient, type Project } from "./flagsmith.js";
import { buildFlagFile, fileNameFor, toYaml } from "./flagfile.js";

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

program.command("plan").description("Show what apply would change").action(() => {
  console.log("plan: not built yet");
});

program.command("apply").description("Push YAML changes to Flagsmith").action(() => {
  console.log("apply: not built yet");
});

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
