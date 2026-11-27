// Entry point for the GitHub Action (see action.yml). Written in Node instead of a
// shell script so it runs the same on Linux, macOS and Windows runners.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { guardOutput } from "./diff.js";

const input = (name: string) => (process.env[`INPUT_${name}`] ?? "").trim();

function fail(message: string): never {
  console.log(`::error::${message}`);
  process.exit(1);
}

const command = input("COMMAND");
if (!["validate", "plan", "apply", "drift"].includes(command)) {
  fail(`command must be validate, plan, apply or drift, got '${command}'`);
}

const actionRoot = process.env.GITHUB_ACTION_PATH ?? path.resolve(path.dirname(process.argv[1]), "..");
const cli = path.join(actionRoot, "dist", "cli.cjs");

// validate works offline: no key, no URL, safe on pull requests from forks.
if (command === "validate") {
  const r = spawnSync(process.execPath, [cli, "validate", "--dir", input("DIR") || "flags"], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// plan and drift only read, so they can use read-only environment keys. apply needs the admin key.
const hasEnvKeys = Boolean(process.env.FLAGSMITH_ENVIRONMENT_KEYS?.trim());
if (command === "apply" || !hasEnvKeys) {
  if (hasEnvKeys) delete process.env.FLAGSMITH_ENVIRONMENT_KEYS; // apply always uses the admin key
  if (!process.env.FLAGSMITH_ADMIN_KEY?.trim()) {
    fail(
      command === "apply"
        ? "admin-key is empty. Add the secret FLAGSMITH_ADMIN_KEY to the job's GitHub Environment (Settings -> Environments)."
        : "Set environment-keys (read-only server-side keys, recommended) or admin-key.",
    );
  }
} else {
  delete process.env.FLAGSMITH_ADMIN_KEY; // read-only run: don't pass the admin key on
}
if (!process.env.FLAGSMITH_API_URL?.trim()) {
  fail("api-url is empty. Add a repository variable FLAGSMITH_API_URL (Settings -> Secrets and variables -> Actions -> Variables).");
}

const args = ["--dir", input("DIR") || "flags"];
if (input("PROJECT")) args.push("--project", input("PROJECT"));
for (const env of input("ENVIRONMENTS").split(",").map((e) => e.trim()).filter(Boolean)) {
  args.push("--env", env);
}

const runnerTemp = process.env.RUNNER_TEMP ?? ".";
const reportFile = path.join(runnerTemp, `flagops-${command}.md`);

const extra = command === "apply" ? ["--yes"] : ["--format", "markdown", "--out", reportFile];
const result = spawnSync(process.execPath, [cli, command, ...args, ...extra], {
  stdio: ["inherit", "inherit", "pipe"],
  encoding: "utf8",
});
const stderr = (result.stderr ?? "").trim();
if (stderr) process.stderr.write(guardOutput(stderr) + "\n");
const status = result.status ?? 1;
// drift exits with 2 when it finds drift: that's a result, not a failure of this step.
if (status !== 0 && !(command === "drift" && status === 2)) {
  // Show the reason on the run's summary page, not only in the log. Skip Node's own warnings.
  const reason = stderr.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("(node:") && !l.startsWith("(Use `node"));
  fail(`flagops ${command} failed: ${(reason.join("\n") || `exit code ${status}`).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
}

const output = (lines: string) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
};

if (command !== "apply") {
  const report = readFileSync(reportFile, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  output(`report-file=${reportFile}\n`);
}
if (command === "plan") {
  output(`changes=${/\*\*(\d+) change/.exec(readFileSync(reportFile, "utf8"))?.[1] ?? "0"}\n`);
}
if (command === "drift") {
  output(`drift=${status === 2}\n`);
  if (status === 2) console.log("::warning::Flagsmith has drifted from the flag files in Git.");
}
