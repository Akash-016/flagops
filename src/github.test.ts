import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMMENT_MARKER, DRIFT_MARKER, driftFailedMarkdown } from "./diff.js";
import { fitBody, postPlan, syncDriftIssue, type Context, type GitHub } from "./github.js";

const context: Context = { serverUrl: "https://github.com", runId: 7, repo: { owner: "o", repo: "r" }, issue: { number: 3 } };
const log = { info: () => {} };

function file(text: string): string {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "flagops-gh-")), "report.md");
  writeFileSync(f, text);
  return f;
}

// A fake Octokit: listed items in, recorded calls out.
function fake(items: object[]) {
  const calls: [string, Record<string, unknown>][] = [];
  const rec = (name: string) => async (p: Record<string, unknown>) => {
    calls.push([name, p]);
    return { data: { number: 42 } };
  };
  const github: GitHub = {
    paginate: async <T>() => items as T[],
    rest: {
      issues: {
        listComments: "listComments",
        listForRepo: "listForRepo",
        createComment: rec("createComment"),
        updateComment: rec("updateComment"),
        create: rec("create"),
        update: rec("update"),
      },
    },
  };
  return { github, calls };
}

const bot = { type: "Bot", login: "github-actions[bot]" };
const otherBot = { type: "Bot", login: "renovate[bot]" };
const person = { type: "User" };

describe("plan comment", () => {
  it("creates one comment, then updates its own on later runs", async () => {
    const first = fake([]);
    expect(await postPlan(first.github, context, file(`${COMMENT_MARKER}\nplan`))).toBe("created");
    expect(first.calls).toEqual([["createComment", { owner: "o", repo: "r", issue_number: 3, body: `${COMMENT_MARKER}\nplan` }]]);

    const later = fake([{ id: 9, user: bot, body: `${COMMENT_MARKER}\nold` }]);
    expect(await postPlan(later.github, context, file(`${COMMENT_MARKER}\nnew`))).toBe("updated");
    expect(later.calls).toEqual([["updateComment", { owner: "o", repo: "r", comment_id: 9, body: `${COMMENT_MARKER}\nnew` }]]);
  });

  it("ignores another bot's comment that starts with the marker, but follows bot-login", async () => {
    const { github, calls } = fake([{ id: 9, user: otherBot, body: `${COMMENT_MARKER}\nnot ours` }]);
    expect(await postPlan(github, context, file(`${COMMENT_MARKER}\nplan`))).toBe("created");
    expect(calls[0][0]).toBe("createComment");
    const app = fake([{ id: 9, user: otherBot, body: `${COMMENT_MARKER}\nold` }]);
    expect(await postPlan(app.github, context, file(`${COMMENT_MARKER}\nplan`), "renovate[bot]")).toBe("updated");
  });

  it("ignores a person's comment that starts with the marker", async () => {
    const { github, calls } = fake([{ id: 9, user: person, body: `${COMMENT_MARKER}\nfake plan` }]);
    expect(await postPlan(github, context, file(`${COMMENT_MARKER}\nplan`))).toBe("created");
    expect(calls[0][0]).toBe("createComment");
  });

  it("cuts a body over GitHub's limit at a line break and links the run summary", () => {
    const body = fitBody("x".repeat(100) + "\n" + "y".repeat(70_000), context);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("[run summary](https://github.com/o/r/actions/runs/7)");
    expect(fitBody("short", context)).toBe("short");
  });
});

describe("drift issue", () => {
  const report = () => file(`${DRIFT_MARKER}\n## Flag drift detected`);

  it("opens an issue on drift", async () => {
    const { github, calls } = fake([]);
    expect(await syncDriftIssue(github, context, log, report(), true)).toBe("opened");
    expect(calls[0]).toEqual(["create", expect.objectContaining({ title: "Flag drift: Flagsmith no longer matches Git" })]);
  });

  it("updates its own open issue instead of opening another", async () => {
    const { github, calls } = fake([{ id: 1, number: 5, user: bot, body: `${DRIFT_MARKER}\nold` }]);
    expect(await syncDriftIssue(github, context, log, report(), true)).toBe("updated");
    expect(calls).toEqual([["update", expect.objectContaining({ issue_number: 5 })]]);
  });

  it("comments and closes its issue once Git and Flagsmith match", async () => {
    const { github, calls } = fake([{ id: 1, number: 5, user: bot, body: `${DRIFT_MARKER}\nold` }]);
    expect(await syncDriftIssue(github, context, log, report(), false)).toBe("closed");
    expect(calls.map((c) => c[0])).toEqual(["createComment", "update"]);
    expect(calls[1][1]).toMatchObject({ issue_number: 5, state: "closed", state_reason: "completed" });
  });

  it("opens an issue when the check itself fails, and comments on an open one instead", async () => {
    const failed = file(driftFailedMarkdown("Flagsmith GET .../environment-document/ failed: no answer in 30 s"));
    const fresh = fake([]);
    expect(await syncDriftIssue(fresh.github, context, log, failed, false, true)).toBe("opened");
    expect(fresh.calls[0]).toEqual(["create", expect.objectContaining({ title: "Flag drift check failed" })]);

    const open = fake([{ id: 1, number: 5, user: bot, body: `${DRIFT_MARKER}\nold drift` }]);
    expect(await syncDriftIssue(open.github, context, log, failed, false, true)).toBe("updated");
    expect(open.calls.map((c) => c[0])).toEqual(["createComment"]);
    expect(String(open.calls[0][1].body)).toContain("The latest drift check failed");
  });

  it("leaves alone issues by people and pull requests, even with the marker", async () => {
    const { github, calls } = fake([
      { id: 1, number: 5, user: person, body: `${DRIFT_MARKER}\nfake` },
      { id: 2, number: 6, user: bot, body: `${DRIFT_MARKER}\npr`, pull_request: {} },
    ]);
    expect(await syncDriftIssue(github, context, log, report(), false)).toBe("none");
    expect(calls).toEqual([]);
  });
});
