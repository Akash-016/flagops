#!/usr/bin/env node
import { Command } from "commander";
import { getConfig } from "./config.js";

const program = new Command();

program
  .name("flagops")
  .description("Manage Flagsmith flags like code: every change reviewed in a pull request.");

// Temporary: checks we can reach Flagsmith with the Admin API key.
program
  .command("check")
  .description("Check the connection to Flagsmith")
  .action(async () => {
    const { apiUrl, adminKey } = getConfig();
    const res = await fetch(`${apiUrl}/projects/`, {
      headers: { Authorization: `Api-Key ${adminKey}` },
    });
    if (!res.ok) {
      console.error(`Flagsmith answered ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const projects = (await res.json()) as Array<{ id: number; name: string }>;
    console.log(`Connected to ${apiUrl}`);
    for (const p of projects) console.log(`  project ${p.id}: ${p.name}`);
  });

program.command("pull").description("Export flags to flags/<env>.yaml").action(() => {
  console.log("pull: not built yet");
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
