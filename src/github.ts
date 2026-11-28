// The two steps of the Action that write to GitHub: the plan comment on a pull request, and
// the drift issue. action.yml runs them through actions/github-script, which passes in an
// authenticated Octokit ("github") and the event ("context").

import { readFileSync } from "node:fs";
import { COMMENT_MARKER, DRIFT_MARKER } from "./diff.js";

// Just the Octokit calls used here, so tests can pass a fake.
export interface GitHub {
  paginate<T>(method: unknown, params: Record<string, unknown>): Promise<T[]>;
  rest: {
    issues: {
      listComments: unknown;
      listForRepo: unknown;
      createComment(p: Record<string, unknown>): Promise<unknown>;
      updateComment(p: Record<string, unknown>): Promise<unknown>;
      create(p: Record<string, unknown>): Promise<{ data: { number: number } }>;
      update(p: Record<string, unknown>): Promise<unknown>;
    };
  };
}

export interface Context {
  serverUrl: string;
  runId: number;
  repo: { owner: string; repo: string };
  issue: { number: number };
}

interface Log {
  info(message: string): void;
}

// GitHub rejects comment and issue bodies over 65,536 characters; the job summary has the full report.
const LIMIT = 60_000;

export function fitBody(body: string, context: Context): string {
  if (body.length <= LIMIT) return body;
  const summary = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const cut = body.lastIndexOf("\n", LIMIT);
  return `${body.slice(0, cut > 0 ? cut : LIMIT)}\n\n**Cut short:** the full report is in the [run summary](${summary}).\n`;
}

interface Authored {
  id: number;
  number?: number;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
  pull_request?: unknown;
}

// The login FlagOps posts as: GITHUB_TOKEN posts as github-actions[bot]; a GitHub App token
// posts as "<app>[bot]" (the bot-login input).
export const DEFAULT_BOT = "github-actions[bot]";

// Only FlagOps's own comment or issue counts: anyone, another bot included, can write one that
// starts with the marker.
const ours = (item: Authored, marker: string, bot: string) =>
  item.user?.type === "Bot" && item.user?.login === bot && Boolean(item.body?.startsWith(marker));

// Posts the plan as one comment on the pull request, and updates that comment on later runs.
export async function postPlan(github: GitHub, context: Context, file: string, bot = DEFAULT_BOT): Promise<"created" | "updated"> {
  const body = fitBody(readFileSync(file, "utf8"), context);
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;
  const comments = await github.paginate<Authored>(github.rest.issues.listComments, { owner, repo, issue_number });
  const mine = comments.find((c) => ours(c, COMMENT_MARKER, bot));
  if (mine) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
    return "updated";
  }
  await github.rest.issues.createComment({ owner, repo, issue_number, body });
  return "created";
}

// Opens an issue when there is drift, keeps it up to date, and closes it once Git and Flagsmith match.
export async function syncDriftIssue(
  github: GitHub,
  context: Context,
  log: Log,
  file: string,
  drift: boolean,
  failed = false,
  bot = DEFAULT_BOT,
): Promise<"opened" | "updated" | "closed" | "none"> {
  const body = fitBody(readFileSync(file, "utf8"), context);
  const { owner, repo } = context.repo;
  const open = await github.paginate<Authored>(github.rest.issues.listForRepo, { owner, repo, state: "open", per_page: 100 });
  const existing = open.find((i) => !i.pull_request && ours(i, DRIFT_MARKER, bot));
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  if (failed && existing) {
    // Keep the drift details already in the issue; say the latest check couldn't run.
    await github.rest.issues.createComment({ owner, repo, issue_number: existing.number, body: `The latest drift check failed ([run](${runUrl})):\n\n${body.split("\n").slice(1).join("\n")}` });
    log.info(`Drift check failed; commented on issue #${existing.number}`);
    return "updated";
  }
  if (failed) {
    const { data } = await github.rest.issues.create({ owner, repo, title: "Flag drift check failed", body });
    log.info(`Drift check failed; opened issue #${data.number}`);
    return "opened";
  }
  if (drift && existing) {
    await github.rest.issues.update({ owner, repo, issue_number: existing.number, title: "Flag drift: Flagsmith no longer matches Git", body });
    log.info(`Updated drift issue #${existing.number}`);
    return "updated";
  }
  if (drift) {
    const { data } = await github.rest.issues.create({ owner, repo, title: "Flag drift: Flagsmith no longer matches Git", body });
    log.info(`Opened drift issue #${data.number}`);
    return "opened";
  }
  if (existing) {
    await github.rest.issues.createComment({ owner, repo, issue_number: existing.number, body: `Flagsmith matches Git again ([check run](${runUrl})). Closing.` });
    await github.rest.issues.update({ owner, repo, issue_number: existing.number, state: "closed", state_reason: "completed" });
    log.info(`Closed drift issue #${existing.number}`);
    return "closed";
  }
  log.info("No drift and no open drift issue.");
  return "none";
}
