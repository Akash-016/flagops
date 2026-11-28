import { describe, expect, it } from "vitest";
import { planSetup, RULESET_NAME, runSetup, type Gh, type SetupOptions } from "./setup.js";

const options: SetupOptions = {
  repo: "o/r",
  apiUrl: "https://flagsmith.example.com/api/v1",
  adminKey: "ADMIN-SECRET",
  environmentKeys: ["ser.a", "ser.b"],
  reviewers: ["teammate"],
  approvals: 1,
  blockAdminBypass: true,
};

// A fake gh: answers GET requests from \`state\`, records every call with its stdin.
function fakeGh(state: { rulesets?: { id: number; name: string }[]; policies?: string[]; fail?: string } = {}) {
  const calls: { args: string[]; input?: string }[] = [];
  const gh: Gh = (args, input) => {
    calls.push({ args, input });
    const path = args[0] === "api" ? args[5] : "";
    if (state.fail && args.join(" ").includes(state.fail)) return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    if (path === "users/teammate") return { status: 0, stdout: JSON.stringify({ id: 77 }), stderr: "" };
    if (path.endsWith("/deployment-branch-policies") && args[2] === "GET") {
      return { status: 0, stdout: JSON.stringify({ branch_policies: (state.policies ?? []).map((name) => ({ name })) }), stderr: "" };
    }
    if (path === "repos/o/r/rulesets" && args[2] === "GET") return { status: 0, stdout: JSON.stringify(state.rulesets ?? []), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { gh, calls };
}

const body = (c: { input?: string }) => JSON.parse(c.input ?? "{}");

describe("setup-github", () => {
  it("explains a plan that doesn't allow required reviewers", () => {
    const gh: Gh = (args) =>
      args.includes("repos/o/r/environments/production") && args[2] === "PUT"
        ? { status: 1, stdout: "", stderr: "gh: Please ensure the billing plan supports the required reviewers protection rule. (HTTP 422)" }
        : fakeGh().gh(args);
    const result = runSetup(planSetup(gh, options), () => {});
    expect(result.done).toBe(3);
    expect(result.failed).toContain("run again without --reviewer");
  });

  it("sets the variable, secrets, environments and ruleset, with secrets only on stdin", () => {
    const { gh, calls } = fakeGh();
    const result = runSetup(planSetup(gh, options), () => {});
    expect(result).toEqual({ done: 5 });

    expect(calls.some((c) => c.args.join(" ") === "variable set FLAGSMITH_API_URL --repo o/r --body https://flagsmith.example.com/api/v1")).toBe(true);
    const secrets = calls.filter((c) => c.args[0] === "secret");
    expect(secrets.map((c) => [c.args.join(" "), c.input])).toEqual([
      ["secret set FLAGSMITH_ENVIRONMENT_KEYS --repo o/r", "ser.a ser.b"],
      ["secret set FLAGSMITH_ADMIN_KEY --env non-production --repo o/r", "ADMIN-SECRET"],
      ["secret set FLAGSMITH_ADMIN_KEY --env production --repo o/r", "ADMIN-SECRET"],
    ]);
    // No secret ever appears in an argument list.
    for (const c of calls) expect(c.args.join(" ")).not.toMatch(/ADMIN-SECRET|ser\.a/);

    const prod = calls.find((c) => c.args[2] === "PUT" && c.args[5] === "repos/o/r/environments/production")!;
    expect(body(prod)).toMatchObject({ reviewers: [{ type: "User", id: 77 }], prevent_self_review: true, deployment_branch_policy: { custom_branch_policies: true } });
    const nonProd = calls.find((c) => c.args[2] === "PUT" && c.args[5] === "repos/o/r/environments/non-production")!;
    expect(body(prod).can_admins_bypass).toBe(false);
    expect(body(nonProd).reviewers).toBeUndefined();
    expect(body(nonProd).can_admins_bypass).toBeUndefined();
    expect(calls.filter((c) => c.args[2] === "POST" && c.args[5].endsWith("/deployment-branch-policies")).map(body)).toEqual([
      { name: "main", type: "branch" },
      { name: "main", type: "branch" },
    ]);

    const ruleset = calls.find((c) => c.args[2] === "POST" && c.args[5] === "repos/o/r/rulesets")!;
    const rules = body(ruleset).rules.map((r: { type: string }) => r.type);
    expect(rules).toEqual(["deletion", "non_fast_forward", "pull_request", "required_status_checks"]);
  });

  it("updates on a second run instead of adding copies", () => {
    const { gh, calls } = fakeGh({ rulesets: [{ id: 9, name: RULESET_NAME }], policies: ["main"] });
    expect(runSetup(planSetup(gh, options), () => {}).failed).toBeUndefined();
    expect(calls.some((c) => c.args[2] === "PUT" && c.args[5] === "repos/o/r/rulesets/9")).toBe(true);
    expect(calls.some((c) => c.args[2] === "POST")).toBe(false);
  });

  it("stops at the first failure and explains GitHub's plan limit in plain words", () => {
    const { gh } = fakeGh({ fail: "environments/non-production" });
    const log: string[] = [];
    const result = runSetup(planSetup(gh, options), (l) => log.push(l));
    expect(result.done).toBe(2);
    expect(result.failed).toContain("need GitHub Pro, Team or Enterprise");
    expect(log.at(-1)).toContain("FAILED");
  });
});
