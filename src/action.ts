// Entry point for the GitHub Action (see action.yml). Written in Node instead of a
// shell script so it runs the same on Linux, macOS and Windows runners.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const input = (name: string) => (process.env[`INPUT_${name}`] ?? "").trim();

function fail(message: string): never {
  console.log(`::error::${message}`);
  process.exit(1);
}

const command = input("COMMAND");
if (command !== "plan" && command !== "apply") fail(`command must be plan or apply, got '${command}'`);
if (!process.env.FLAGSMITH_ADMIN_KEY?.trim()) {
  fail("admin-key is empty. Add a repository secret FLAGSMITH_ADMIN_KEY (Settings -> Secrets and variables -> Actions).");
}
if (!process.env.FLAGSMITH_API_URL?.trim()) {
  fail("api-url is empty. Add a repository variable FLAGSMITH_API_URL (Settings -> Secrets and variables -> Actions -> Variables).");
}

const args = ["--dir", input("DIR") || "flags"];
if (input("PROJECT")) args.push("--project", input("PROJECT"));
for (const env of input("ENVIRONMENTS").split(",").map((e) => e.trim()).filter(Boolean)) {
  args.push("--env", env);
}

// dist/cli.cjs inside the action's folder (GitHub sets GITHUB_ACTION_PATH).
const actionRoot = process.env.GITHUB_ACTION_PATH ?? path.resolve(path.dirname(process.argv[1]), "..");
const cli = path.join(actionRoot, "dist", "cli.cjs");
const runnerTemp = process.env.RUNNER_TEMP ?? ".";
const planFile = path.join(runnerTemp, "flagops-plan.md");

const extra = command === "plan" ? ["--format", "markdown", "--out", planFile] : ["--yes"];
const result = spawnSync(process.execPath, [cli, command, ...args, ...extra], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

if (command === "plan") {
  const plan = readFileSync(planFile, "utf8");
  const changes = /\*\*(\d+) change/.exec(plan)?.[1] ?? "0";
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, plan);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `plan-file=${planFile}\nchanges=${changes}\n`);
  }
}
