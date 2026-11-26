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
if (command !== "plan" && command !== "apply") fail(`command must be plan or apply, got '${command}'`);
if (!process.env.FLAGSMITH_ADMIN_KEY?.trim()) {
  fail("admin-key is empty. Add a repository secret FLAGSMITH_ADMIN_KEY (Settings -> Secrets and variables -> Actions).");
}
if (!process.env.FLAGSMITH_API_URL?.trim()) {
  fail("api-url is empty. Add a repository variable FLAGSMITH_API_URL (Settings -> Secrets and variables -> Actions -> Variables).");
}
var args = ["--dir", input("DIR") || "flags"];
if (input("PROJECT")) args.push("--project", input("PROJECT"));
for (const env of input("ENVIRONMENTS").split(",").map((e) => e.trim()).filter(Boolean)) {
  args.push("--env", env);
}
var actionRoot = process.env.GITHUB_ACTION_PATH ?? import_node_path.default.resolve(import_node_path.default.dirname(process.argv[1]), "..");
var cli = import_node_path.default.join(actionRoot, "dist", "cli.cjs");
var runnerTemp = process.env.RUNNER_TEMP ?? ".";
var planFile = import_node_path.default.join(runnerTemp, "flagops-plan.md");
var extra = command === "plan" ? ["--format", "markdown", "--out", planFile] : ["--yes"];
var result = (0, import_node_child_process.spawnSync)(process.execPath, [cli, command, ...args, ...extra], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (command === "plan") {
  const plan = (0, import_node_fs.readFileSync)(planFile, "utf8");
  const changes = /\*\*(\d+) change/.exec(plan)?.[1] ?? "0";
  if (process.env.GITHUB_STEP_SUMMARY) (0, import_node_fs.appendFileSync)(process.env.GITHUB_STEP_SUMMARY, plan);
  if (process.env.GITHUB_OUTPUT) {
    (0, import_node_fs.appendFileSync)(process.env.GITHUB_OUTPUT, `plan-file=${planFile}
changes=${changes}
`);
  }
}
