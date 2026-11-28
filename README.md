# FlagOps

[![CI](https://github.com/Akash-016/flagops/actions/workflows/ci.yml/badge.svg)](https://github.com/Akash-016/flagops/actions/workflows/ci.yml)

**Review every Flagsmith flag change in a pull request, and know when someone changes production by hand.**

Built for the WeMakeDevs × Flagsmith hackathon, **Track 3: Build on Open Source Flagsmith**.

![FlagOps posts the plan for a flag change on the pull request](docs/pr-comment.png)

## The problem

On self-hosted Flagsmith, anyone with dashboard access can flip a production flag. There is no review step between a wrong click and your users, and no record in Git of what changed or why. Over time, flags pile up that nobody dares to delete.

## What FlagOps does

Your flags live in YAML files in a Git repo, one file per environment. FlagOps keeps Flagsmith and those files in step:

| | |
|---|---|
| **Plan on every pull request** | A bot comments with a table of what will change, in which environment, and where in your code each changed flag is used. |
| **Apply on merge** | Development and Staging update first. Production waits until a named reviewer approves. |
| **Segment overrides** | Per-segment on/off and value, in priority order, reviewed like any other change: "beta users get the new search in Production" is a pull request. |
| **Catch drift** | A scheduled check opens an issue when a flag's on/off, value or segment overrides in Flagsmith no longer match Git (someone used the dashboard), and closes it once fixed. |
| **Find stale flags** | Lists flags with the same setting in every environment for 30+ days, with the code to clean up. |
| **Validate offline** | Checks the files without an API key, so it runs safely on every pull request, forks included. |
| **Never deletes flags** | Flags missing from YAML are reported, not removed. |

It ships as a CLI, a GitHub Action, and a one-command Docker setup.

## See it working

The [demo repo](https://github.com/Akash-016/flagops-demo) runs FlagOps against a real self-hosted Flagsmith:

- [Pull request turning on a flag in production](https://github.com/Akash-016/flagops-demo/pull/3), with the plan comment.
- [The apply run](https://github.com/Akash-016/flagops-demo/actions/runs/45822896350) for that merge. Development and Staging updated at once, and Production waited in its own job until the maintainer approved it (self-review was still allowed then; see the demo README).
- [A drift issue](https://github.com/Akash-016/flagops-demo/issues/2) FlagOps opened after a dashboard edit, and closed by itself once Git and Flagsmith matched again.
- Segment overrides: [a pull request giving beta testers the new search in Production](https://github.com/Akash-016/flagops-demo/pull/8), [its apply run](https://github.com/Akash-016/flagops-demo/actions/runs/46086054326), where Production waited in its own job (the demo has one maintainer, so the owner released it as admin; see the demo README), and [the drift issue](https://github.com/Akash-016/flagops-demo/issues/9) opened when the override was turned off outside Git, closed by itself after `flagops apply` put it back.
- [CI](https://github.com/Akash-016/flagops/actions/workflows/ci.yml) runs a full round trip against Flagsmith in Docker on every push.

## Quick start

**1. Start self-hosted Flagsmith**

```bash
git clone https://github.com/Akash-016/flagops.git
cd flagops
docker compose up -d
```

Open http://localhost:8000, sign up, and create an organisation and a project.

**2. Create an Admin API key**

Organisation Settings → API Keys → Create. Put it in a `.env` file (never commit it):

```bash
FLAGSMITH_API_URL=http://localhost:8000/api/v1
FLAGSMITH_ADMIN_KEY=your-key
```

**3. Optional: load demo data** (3 environments, 7 sample flags, 2 segments and a segment override)

```bash
npm install
npm run seed
```

**4. Export your flags to YAML**

```bash
npx github:Akash-016/flagops pull
```

This writes `flags/development.yaml`, `flags/staging.yaml` and `flags/production.yaml`. Edit one, then:

```bash
npx github:Akash-016/flagops plan     # what would change
npx github:Akash-016/flagops apply    # make the change (asks first)
```

**5. Add the GitHub Action** to the repo that holds your `flags/` folder

1. Copy the four files from [`examples/workflows/`](examples/workflows) to `.github/workflows/`.
2. In Flagsmith, create a server-side key for each environment (Environment settings → SDK Keys → Server-side). These can read flags but not change them.
3. Settings → Secrets and variables → Actions: add the variable `FLAGSMITH_API_URL` and the secret `FLAGSMITH_ENVIRONMENT_KEYS` (the server-side keys, separated by spaces). `plan` and `drift` use these.
4. Settings → Environments: create `non-production` and `production`. For both, set Deployment branches to `main` only and add the environment secret `FLAGSMITH_ADMIN_KEY`. For `production`, also add Required reviewers, turn on Prevent self-review, and turn off Allow administrators to bypass (on by default). Only `apply` uses the admin key. **Check your GitHub plan:** in private repositories, environments (with their secrets and branch limits) need GitHub Pro, Team or Enterprise, and required reviewers need Enterprise. On GitHub Free, use a public repository.
5. Protect `main` with a ruleset: require a pull request with at least one approval, require review from code owners, and make `validate` a required status check. Add a `CODEOWNERS` line such as `/.github/ @your-team`, so workflow changes (and `CODEOWNERS` itself) need review.
6. Read the [security model](#security-model).

The examples use GitHub's `ubuntu-latest` runners, which need Flagsmith on an address they can reach. If Flagsmith runs on a private network, use a [self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners), preferably in a private repo on a plan that has environments and required reviewers (see step 4). On a public repo, follow the runner advice in the [security model](#security-model). The [demo repo](https://github.com/Akash-016/flagops-demo) is public and runs Flagsmith on the maintainer's machine.

## How FlagOps uses Flagsmith

FlagOps talks to the **Flagsmith Admin API** of a self-hosted instance, authenticated with an organisation API key (`Authorization: Api-Key ...`). In CI, `plan` and `drift` instead read each environment with a read-only server-side key (`X-Environment-Key: ser...`).

| Endpoint | Used by | For |
|---|---|---|
| `GET /environment-document/` | plan, drift (read-only keys) | One environment's name and every flag's on/off and value |
| `GET /projects/` | all | Find the project |
| `GET /environments/?project=<id>` | all | List environments and their keys |
| `GET /projects/<id>/features/` | all | Flag names, tags, archived state |
| `GET /environments/<key>/featurestates/` | pull, plan, drift, stale | Each flag's on/off, value and last change, per environment |
| `PATCH /environments/<key>/featurestates/<id>/` | apply | Change a flag's on/off and value |
| `POST /projects/<id>/features/` | apply | Create a flag that's new in YAML |
| `GET /projects/<id>/segments/` | pull, plan, drift, apply | Find segments by name |
| `GET /features/featurestates/?environment=<id>` | pull, plan, drift, apply | Segment override settings |
| `GET /features/feature-segments/?environment=<id>&feature=<id>` | pull, plan, drift, apply | Which segment each override is for, and its priority |
| `POST /environments/<key>/features/<id>/create-segment-override/` | apply | Add a segment override |
| `PATCH /features/featurestates/<id>/` | apply | Change a segment override |
| `DELETE /features/feature-segments/<id>/` | apply | Remove a segment override |
| `POST /features/feature-segments/update-priorities/` | apply | Put overrides in the order YAML lists them |
| `GET /projects/<id>/tags/` | stale | Skip flags tagged `permanent` |

With read-only keys, segment overrides and their priorities come from the environment document too. Segment rules and per-user (identity) overrides are left alone.

## Commands

| Command | What it does |
|---|---|
| `flagops validate` | Check the flag files without connecting to Flagsmith: schema, one file per environment, same flags in every file |
| `flagops check` | Test the connection and list projects |
| `flagops pull` | Write each environment's flags to `flags/<environment>.yaml` |
| `flagops plan` | Show what `apply` would change and where the changed flags are used in code |
| `flagops apply` | Make Flagsmith match the YAML. Asks first; `--yes` skips the question (CI) |
| `flagops drift` | Report differences between Flagsmith and YAML. Exit code 2 means drift |
| `flagops stale` | List flags with the same setting everywhere, unchanged for `--days` (default 30) |

`plan` and `drift` use read-only keys when `FLAGSMITH_ENVIRONMENT_KEYS` is set (server-side keys separated by spaces), and the admin key otherwise.

Common options:

| Option | Meaning |
|---|---|
| `-p, --project <id or name>` | Pick the project if there are several |
| `-d, --dir <dir>` | Folder with the flag files (default `flags`) |
| `-e, --env <name>` | Only this environment; repeat for more |
| `-f, --format markdown` | Markdown output (used for PR comments and issues) |
| `--code <dir>` / `--no-code` | Where to search for flag usage, or don't search |

## YAML format

```yaml
environment: Production
flags:
  checkout_v2:
    enabled: false
    value: null
  max_cart_items:
    enabled: true
    value: 25
```

Every flag needs both `enabled` and `value`. `value` can be text, a whole number, `true`/`false`, or `null`. Flag names can be anything Flagsmith stores unchanged: up to 2000 characters, no control characters, no leading or trailing spaces. FlagOps escapes names and values wherever they appear in Markdown, so they can't add formatting, links or mentions. Anything else stops every command with the exact place, including values Flagsmith would store differently (decimals, numbers above 2147483647, text with leading or trailing spaces as Python's `strip()` sees them) and misspelt keys:

```
production.yaml is not a valid flag file:
  flags.max_cart_items: Unrecognized key: "vaule"
```

**Archived flags** are marked `archived: true` and keep their settings, because Flagsmith still serves archived flags to SDKs. `flagops pull` writes this for you. `apply` and `drift` treat its settings like any other flag's, so a change to an archived flag is reviewed in a pull request, and a dashboard edit to one opens a drift issue. Archiving and unarchiving stay in the dashboard; `apply` never does either, and can't create a flag that is marked archived:

```yaml
  old_banner:
    archived: true
    enabled: false
    value: null
```

If a flag is archived on one side only (archived or unarchived in the dashboard, or deleted and recreated), `drift` with the admin key reports it, and `apply` stops without changing anything until you update the YAML or the dashboard.

**Segment overrides** give a flag a different setting for users in a segment. List them under `segments`, highest priority first (the first segment a user matches wins). The segments themselves, with their rules, live in Flagsmith; YAML names them, and each name must match exactly one segment:

```yaml
  new_search:
    enabled: false
    value: null
    segments:
      - segment: beta_testers
        enabled: true
        value: null
      - segment: staff
        enabled: true
        value: "v2"
```

With a `segments` list, Git is the record: `apply` adds, changes, removes and reorders that flag's overrides to match, and `drift` reports any dashboard change to them, including a segment renamed or deleted in the dashboard. If a segment name in YAML matches no segment, or several, `plan` and `drift` show it, and `apply` leaves that flag's overrides alone (applying everything else) and then fails with the reason. `segments: []` means no overrides. A flag with no `segments` key keeps whatever overrides it has in Flagsmith, so files written before FlagOps managed overrides change nothing; `flagops pull` writes the list for every flag. Overrides can differ between environments.

If Flagsmith holds a flag whose name or value FlagOps can't write back unchanged (a name with a tab, say), `pull` leaves that flag out of every file, says why, and writes the rest. `plan` and `drift` leave such flags out too, since no flag file can hold them; rename them in Flagsmith to manage them. If only a flag's overrides can't be written (one uses a segment name that several segments share), `pull` writes the flag without `segments`, so its overrides stay unmanaged, and says so.

**Every file must list the same flags.** A Flagsmith flag always exists in every environment, so a new flag goes into each file (with `enabled: false` where it should stay off). If it's missing from one, every command stops and says which file to fix.

## GitHub Action

```yaml
- uses: Akash-016/flagops@v1
  with:
    command: plan            # validate, plan, apply or drift
    api-url: ${{ vars.FLAGSMITH_API_URL }}
    environment-keys: ${{ secrets.FLAGSMITH_ENVIRONMENT_KEYS }}   # plan, drift
    # admin-key: ${{ secrets.FLAGSMITH_ADMIN_KEY }}               # apply, from a GitHub Environment
    # environments: Production      # optional, comma-separated
```

| Command | Key | Result |
|---|---|---|
| `validate` | none | Checks the files offline |
| `plan` | `environment-keys` | Posts (and keeps updating) one plan comment on the pull request |
| `apply` | `admin-key` | Applies the YAML. Put production in a job with `environment: production` for approval |
| `drift` | `environment-keys` | Opens an issue on drift and closes it when Flagsmith matches Git again |

`plan` and `drift` also accept `admin-key` if you don't set `environment-keys`, but then a pull request workflow holds the admin key.

`@v1` moves to each compatible release. In jobs that hold the admin key, you can pin a commit instead (`Akash-016/flagops@<sha>`) and update it on purpose, like any other dependency.

The Action is a prebuilt bundle (`dist/`), so it installs nothing and runs in seconds. CI runs `validate`, `plan`, `drift` and `apply` through the Action on Linux against Flagsmith in Docker; the demo runs it on a Windows self-hosted runner.

## Security model

FlagOps makes Git the record of every flag change, and makes production changes wait for a reviewer. Here is what holds that in place, and where it ends.

**Pull requests never see the admin key.** A pull request runs its workflow files from its own branch, so anyone with write access can edit a workflow in a pull request and it runs before review. CODEOWNERS and branch protection only block the merge, not that run. So with the recommended setup, pull request workflows hold nothing that can change flags:

- `plan` and `drift` read flags with server-side environment keys. Flagsmith's Admin API rejects these keys (CI checks this), so they can't change flag settings. They can still do what a server-side SDK does, such as create identities and set traits, which can move users into segments. Treat them as secrets.
- The admin key is only an environment secret of the `non-production` and `production` GitHub Environments. Both accept deployments from `main` only, so a job started from a pull request or another branch can't get it. Don't also store it as a repository secret.
- To change flags, a change must reach `main`, through a pull request if branch protection requires one. Production also waits for a required reviewer.

**The production gate is only as strong as the review of workflow changes.** Flagsmith organisation API keys can change every environment, so the `non-production` job holds a key that could change Production too; only its workflow file limits it to Development and Staging. Someone who can merge a workflow change without review can remove that limit. Require approvals and code owner review for `.github/`, as in the [quick start](#quick-start). A one-person repository, like the demo, can't require a second reviewer, so there the gate stops mistakes, not its owner.

**What a writer can still do:** read what the read-only keys can see: flag settings, segment rules and identity overrides (check whether yours hold user identifiers such as emails), and push to `main` if branch protection allows it. Use branch protection or a ruleset on `main`, and limit who can bypass it.

**Other points:**

- **Fork pull requests get no secrets.** The examples run only `validate` for forks and skip `plan`.
- **Drift is a backstop for what FlagOps manages.** A change to a flag's default on/off or value outside a reviewed merge, from the dashboard or from a misused key, shows up in the next drift check as an issue, archived flags included. Drift sees segment overrides on flags with a `segments` list; it does not see identity overrides, segment rules, or environments with no flag file. With read-only keys it also can't see whether a flag is archived; run drift with the admin key from a scheduled job on `main` to catch that.
- **Self-hosted runners belong on private repos.** On a public repo, a fork pull request can add a workflow that runs on the runner's machine. If you must (the [demo](https://github.com/Akash-016/flagops-demo) does, to reach a laptop), require approval for workflows from all outside contributors, and keep no other secrets on that machine: any job that reaches the runner can read them. If the runner's machine also hosts Flagsmith, as in the demo, a job on it can likely reach Flagsmith's database directly and skip every control above, so do this only for a demo.
- **`stale` needs the admin key**, because only the Admin API reports when each flag last changed. Run it locally, not from pull requests.

## Limits

- Segment rules, identity overrides and multivariate weights are not managed. For a multivariate flag FlagOps sets the control value, and the plan comment says that the variant weights still apply.
- Environments that use feature versioning (v2) can be planned and checked for drift, but if a run would change one, `apply` stops before changing anything in any environment.
- An override and its order are separate calls, so if `apply` stops halfway, a new override can briefly sit at the end of the list. Run `apply` again.
- `apply` never deletes flags. Flags removed from YAML are reported as "left alone".
- `apply` stops at the first failed change and lists what it did; there is no rollback. Run it again after fixing the cause.
- `apply` makes each environment match its whole flag file, not only the flags a merge changed. A dashboard change made since the last drift check is undone by the next apply. The example apply workflow writes the Production plan to the run summary before the approval, so the reviewer sees such a change first.
- Rejecting the production deployment leaves Development and Staging applied and Git ahead of Production. Revert the pull request; otherwise the next drift check reports the difference and the next approved apply makes the rejected change.
- Creating a flag creates it in every environment, even with `--env`.
- Environment documents don't say whether a flag is archived, so with read-only keys, `plan` and `drift` compare archived flags' settings but can't see a flag archived or unarchived in the dashboard. The plan comment says so. Commands with the admin key notice, and `apply` stops with a message saying what to do.
- Flagsmith calls time out after 30 seconds (set `FLAGSMITH_TIMEOUT` in seconds to change it). Reads are retried twice, and any call Flagsmith rate-limits (429) is retried after the time it asks for; other writes are not retried.
- A new flag must be listed in every environment file, because Flagsmith creates each flag in every environment.
- Free Flagsmith organisations get one project; FlagOps works with one project per flags folder.
- `stale` uses Flagsmith's last-update time for each environment's flag state.

## FAQ

**Why not Flagsmith's own change requests?**
Change requests and audit logs aren't in the open-source build; they come with Flagsmith's paid plans ([pricing](https://www.flagsmith.com/pricing)). If you have them, use them. FlagOps gives self-hosted open-source users a review step, and it also puts flag changes in Git next to the code that uses them.

**Why not Terraform?**
Flagsmith has an official Terraform provider, and it's a good choice if you already run Terraform. FlagOps aims at teams that don't: `flagops pull` writes YAML from the flags you already have, with no import step and no state file to store and lock. The plan appears as a pull request comment and shows where each flag is used in your code. Drift and stale-flag reports are built in.

**How is this different from Flagsmith's Code References?**
[Code References](https://docs.flagsmith.com/managing-flags/code-references) shows, in the Flagsmith dashboard, where each flag is used. FlagOps uses the same idea for a different moment: in the pull request that changes a flag, before anything changes, next to the plan and the reviewer who approves it.

**What about segments and per-user overrides?**
Segment overrides are managed (see [YAML format](#yaml-format)). Segment rules and per-user overrides are left to Flagsmith. See [Limits](#limits).

**Can someone bypass the review?**
Not from a pull request: pull request workflows only get read-only keys, and the admin key is only available to `apply` jobs on `main`. Someone who can merge workflow changes without review can, so require reviews for `.github/`. Someone with dashboard access can still change flags, and the drift check reports changes to the flags FlagOps manages. See the [security model](#security-model).

**Will it delete my flags?**
No. Flags missing from the YAML are reported, never removed.

## Development

```bash
npm install
npm test           # unit tests (vitest)
                   # CI also runs a full round trip against Flagsmith in Docker: .github/workflows/ci.yml
npm run build      # type check + bundle to dist/
npm run dev -- plan   # run the CLI from source
```

## License

[MIT](LICENSE) © 2026 Akash V
