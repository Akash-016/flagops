"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/action.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"), 1);
var input = (name) => (process.env[`INPUT_${name}`] ?? "").trim();
function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}
var command = input("COMMAND");
if (!["validate", "plan", "apply", "drift"].includes(command)) {
  fail(`command must be validate, plan, apply or drift, got '${command}'`);
}
var actionRoot = process.env.GITHUB_ACTION_PATH ?? import_node_path.default.resolve(import_node_path.default.dirname(process.argv[1]), "..");
var cli = import_node_path.default.join(actionRoot, "dist", "cli.cjs");
if (command === "validate") {
  const r = (0, import_node_child_process.spawnSync)(process.execPath, [cli, "validate", "--dir", input("DIR") || "flags"], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
var hasEnvKeys = Boolean(process.env.FLAGSMITH_ENVIRONMENT_KEYS?.trim());
if (command === "apply" || !hasEnvKeys) {
  if (hasEnvKeys) delete process.env.FLAGSMITH_ENVIRONMENT_KEYS;
  if (!process.env.FLAGSMITH_ADMIN_KEY?.trim()) {
    fail(
      command === "apply" ? "admin-key is empty. Add the secret FLAGSMITH_ADMIN_KEY to the job's GitHub Environment (Settings -> Environments)." : "Set environment-keys (read-only server-side keys, recommended) or admin-key."
    );
  }
} else {
  delete process.env.FLAGSMITH_ADMIN_KEY;
}
if (!process.env.FLAGSMITH_API_URL?.trim()) {
  fail("api-url is empty. Add a repository variable FLAGSMITH_API_URL (Settings -> Secrets and variables -> Actions -> Variables).");
}
var args = ["--dir", input("DIR") || "flags"];
if (input("PROJECT")) args.push("--project", input("PROJECT"));
for (const env of input("ENVIRONMENTS").split(",").map((e) => e.trim()).filter(Boolean)) {
  args.push("--env", env);
}
var runnerTemp = process.env.RUNNER_TEMP ?? ".";
var reportFile = import_node_path.default.join(runnerTemp, `flagops-${command}.md`);
var extra = command === "apply" ? ["--yes"] : ["--format", "markdown", "--out", reportFile];
var result = (0, import_node_child_process.spawnSync)(process.execPath, [cli, command, ...args, ...extra], { stdio: "inherit" });
var status = result.status ?? 1;
if (status !== 0 && !(command === "drift" && status === 2)) process.exit(status);
var output = (lines) => {
  if (process.env.GITHUB_OUTPUT) (0, import_node_fs.appendFileSync)(process.env.GITHUB_OUTPUT, lines);
};
if (command !== "apply") {
  const report = (0, import_node_fs.readFileSync)(reportFile, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) (0, import_node_fs.appendFileSync)(process.env.GITHUB_STEP_SUMMARY, report);
  output(`report-file=${reportFile}
`);
}
if (command === "plan") {
  output(`changes=${/\*\*(\d+) change/.exec((0, import_node_fs.readFileSync)(reportFile, "utf8"))?.[1] ?? "0"}
`);
}
if (command === "drift") {
  output(`drift=${status === 2}
`);
  if (status === 2) console.log("::warning::Flagsmith has drifted from the flag files in Git.");
}
