// flagops setup-github: the GitHub side of the setup, done through the gh CLI (which encrypts
// secrets itself and is already logged in). Every step can run again safely: it updates what
// exists instead of adding a second copy.

import { spawnSync } from "node:child_process";

export interface GhResult {
  status: number;
  stdout: string;
  stderr: string;
}
// Runs gh with these arguments; input goes to stdin (how secrets are passed, never as arguments).
export type Gh = (args: string[], input?: string) => GhResult;

export const realGh: Gh = (args, input) => {
  const r = spawnSync("gh", args, { input, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? r.error.message : "") };
};

export interface SetupOptions {
  repo: string; // owner/name
  apiUrl: string;
  adminKey: string;
  environmentKeys: string[]; // read-only server-side keys, one per environment
  reviewers: string[]; // GitHub logins who may approve production
  approvals: number; // approvals a pull request to main needs
  // Turn off "Allow administrators to bypass" on production. Only safe when someone other than
  // the person running this can approve: with self-review blocked, a sole owner could never deploy.
  blockAdminBypass: boolean;
}

export interface Step {
  title: string;
  run: () => void;
}

export const RULESET_NAME = "FlagOps: protect main";

export class SetupError extends Error {}

// Plain-language reasons for the errors GitHub gives most often here.
function explain(path: string, output: string): string {
  if (/HTTP 404/.test(output) && path.includes("/environments")) {
    return "GitHub refused environments on this repository. In private repositories they need GitHub Pro, Team or Enterprise; on GitHub Free, make the repository public.";
  }
  if (/billing plan/i.test(output)) {
    return "GitHub's plan for this repository doesn't allow required reviewers (in private repositories they need GitHub Enterprise). Make the repository public, or run again without --reviewer to set up everything else.";
  }
  if (/HTTP 403|Resource not accessible|Must have admin rights/i.test(output)) {
    return "you need admin rights on the repository (and a gh login with the repo scope: gh auth refresh -s repo).";
  }
  return output.trim().split("\n")[0] || "no details from gh";
}

function api<T = unknown>(gh: Gh, method: string, path: string, body?: unknown): T {
  const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", path];
  if (body !== undefined) args.push("--input", "-");
  const r = gh(args, body === undefined ? undefined : JSON.stringify(body));
  if (r.status !== 0) throw new SetupError(`${method} ${path}: ${explain(path, r.stderr + r.stdout)}`);
  return (r.stdout.trim() ? JSON.parse(r.stdout) : undefined) as T;
}

function run(gh: Gh, args: string[], input?: string): void {
  const r = gh(args, input);
  if (r.status !== 0) throw new SetupError(`gh ${args.slice(0, 3).join(" ")}: ${explain("", r.stderr + r.stdout)}`);
}

// An environment limited to deployments from main, optionally with required reviewers.
function environment(gh: Gh, repo: string, name: string, reviewerIds: number[], blockAdminBypass = false): void {
  const body: Record<string, unknown> = {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  if (blockAdminBypass) body.can_admins_bypass = false;
  if (reviewerIds.length > 0) {
    body.reviewers = reviewerIds.map((id) => ({ type: "User", id }));
    body.prevent_self_review = true;
  }
  api(gh, "PUT", `repos/${repo}/environments/${name}`, body);
  const policies = api<{ branch_policies: { name: string; type?: string }[] }>(gh, "GET", `repos/${repo}/environments/${name}/deployment-branch-policies`);
  if (!policies.branch_policies.some((p) => p.name === "main")) {
    api(gh, "POST", `repos/${repo}/environments/${name}/deployment-branch-policies`, { name: "main", type: "branch" });
  }
}

export function rulesetBody(approvals: number) {
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: approvals,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "validate" }] },
      },
    ],
  };
}

export function planSetup(gh: Gh, o: SetupOptions): Step[] {
  const reviewerIds = () => o.reviewers.map((login) => api<{ id: number }>(gh, "GET", `users/${login}`).id);
  return [
    {
      title: `Variable FLAGSMITH_API_URL = ${o.apiUrl}`,
      run: () => run(gh, ["variable", "set", "FLAGSMITH_API_URL", "--repo", o.repo, "--body", o.apiUrl]),
    },
    {
      title: `Secret FLAGSMITH_ENVIRONMENT_KEYS (${o.environmentKeys.length} read-only key${o.environmentKeys.length === 1 ? "" : "s"}, for plan and drift)`,
      run: () => run(gh, ["secret", "set", "FLAGSMITH_ENVIRONMENT_KEYS", "--repo", o.repo], o.environmentKeys.join(" ")),
    },
    {
      title: `Environment "non-production": deployments from main only, secret FLAGSMITH_ADMIN_KEY`,
      run: () => {
        environment(gh, o.repo, "non-production", []);
        run(gh, ["secret", "set", "FLAGSMITH_ADMIN_KEY", "--env", "non-production", "--repo", o.repo], o.adminKey);
      },
    },
    {
      title:
        `Environment "production": deployments from main only, secret FLAGSMITH_ADMIN_KEY` +
        (o.reviewers.length > 0 ? `, required reviewers ${o.reviewers.join(", ")}, self-review blocked` : ", no reviewers (add --reviewer)") +
        (o.blockAdminBypass ? ", no admin bypass" : ""),
      run: () => {
        environment(gh, o.repo, "production", reviewerIds(), o.blockAdminBypass);
        run(gh, ["secret", "set", "FLAGSMITH_ADMIN_KEY", "--env", "production", "--repo", o.repo], o.adminKey);
      },
    },
    {
      title: `Ruleset "${RULESET_NAME}": pull requests with ${o.approvals} approval${o.approvals === 1 ? "" : "s"} and code owner review, the "validate" check, no force-push or deletion`,
      run: () => {
        const existing = api<{ id: number; name: string }[]>(gh, "GET", `repos/${o.repo}/rulesets`).find((r) => r.name === RULESET_NAME);
        if (existing) api(gh, "PUT", `repos/${o.repo}/rulesets/${existing.id}`, rulesetBody(o.approvals));
        else api(gh, "POST", `repos/${o.repo}/rulesets`, rulesetBody(o.approvals));
      },
    },
  ];
}

// Runs the steps in order and stops at the first failure. Steps are safe to repeat.
export function runSetup(steps: Step[], log: (line: string) => void): { done: number; failed?: string } {
  let done = 0;
  for (const step of steps) {
    try {
      step.run();
      log(`  done   ${step.title}`);
      done++;
    } catch (err) {
      log(`  FAILED ${step.title}\n         ${(err as Error).message}`);
      return { done, failed: (err as Error).message };
    }
  }
  return { done };
}
