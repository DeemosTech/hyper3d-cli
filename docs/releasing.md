# Release operations

## Branch and version policy

Development branches (for example `dev/*`, `feat/*`, or `fix/*`) target
`prerelease`. Only this repository's `prerelease` branch may target `main`.

| PR direction              | Required source version   |
| ------------------------- | ------------------------- |
| Development -> prerelease | >= prerelease, and > main |
| prerelease -> main        | > main                    |

These comparisons use stable `X.Y.Z` values in `packages/cli/package.json`, not
beta suffixes or text sorting. The root lockfile's `packages/cli` version must
match. CI validates the source, target, and proposed merge result. A mismatch,
version regression, or a direct development PR to main fails `Release policy`
and `CI checks`.

The initial one-commit branch containing only `README.md` and `.gitignore` has no
package version and is treated as `0.0.0` for bootstrap comparisons. No other
missing manifest is allowed. This permits the initial `0.1.0` development PR
without adding package files to the dummy main commit.

After promoting a release, main and prerelease temporarily have equal versions.
The next development PR must raise the planned version above main. For example:

```sh
npm version 0.1.1 --workspace @hyper3d/cli --no-git-tag-version
```

This updates the package and lockfile. Subsequent development PRs may keep that
same version until it is released. Merge main back into a development branch
when needed to keep the release branches up to date; include the next version
bump before targeting prerelease. Prefer merge commits for prerelease -> main.

## Automatic publication

| Trigger                    | npm version                            | npm dist-tag | GitHub release         |
| -------------------------- | -------------------------------------- | ------------ | ---------------------- |
| Merge into prerelease      | Base version + `-beta.<run>.<attempt>` | `beta`       | No                     |
| Merge prerelease into main | Exact source version                   | `latest`     | Yes, with `vX.Y.Z` tag |

With source version `0.1.0`, prerelease run 23 attempt 1 publishes
`0.1.0-beta.23.1`. Promoting to main publishes `0.1.0`, creates `v0.1.0` at that
workflow's exact commit, and creates a GitHub Release with generated notes and
the npm tarball attached. Do not push tags manually to initiate publication;
tag pushes do not trigger the release workflow.

Development PRs and prerelease pushes run the complete Linux/macOS/Windows and
Node.js 22/24 matrix. Formatting and lint run once on Linux; every matrix entry
compiles with TypeScript before testing, which also checks types without a
duplicate `tsc --noEmit` run.

Promotion PRs and main pushes can reuse an already successful prerelease Release
run. The candidate must be the same repository's prerelease PR head, or the second
parent of a main merge commit. Its entire Git tree must equal the checked-out
merge result, and the Release workflow must have succeeded for that exact SHA
on a prerelease push. A different tree, failed/pending verification, squash/rebase
merge, missing history or unavailable Actions API falls back to full CI. Manual CI
runs always use full verification. The workflow token needs `actions: read` to
look up prerelease runs.

`Release policy` always runs. `CI checks` accepts a skipped test matrix only
when prerelease reuse was explicitly verified and the policy job succeeded. Keep
both existing required checks in branch protection. CI changes themselves follow the
normal development -> prerelease -> main flow.

Publishing jobs use a fresh dependency installation without
restoring npm caches, repeat the policy check, select the release version,
reject duplicate or outdated registry versions, smoke-test the packed
installation, upload a tarball artifact, and publish with npm OIDC provenance.
Beta must also be newer than the published stable version. Source version
rewrites during publishing are never committed back to Git.

Running release workflows are not cancelled. The shared concurrency group
serializes releases; GitHub may replace older pending runs with a newer pending
run. Thus beta represents the latest successfully published build, not a promise
that every intermediate merge produces a retained npm version.

PRs run CI once and cancel obsolete runs on new commits. Development pushes do
not publish or trigger duplicate CI. CI can also be run manually once its workflow
is present on the default branch. Test jobs retain npm download caches under
GitHub's repository cache limits; upload artifacts expire after 14 days. Artifact
expiry does not delete npm versions or GitHub Release attachments.

## Skipping a publication

Add the `skip-release` label to the PR before merging into prerelease or main.
The push workflow still runs verification, but skips the publish job, including
npm publication, release artifact upload, tag creation and GitHub Release.
Version policy and required branch checks are unchanged.

Only the merged PR whose merge commit equals the pushed SHA and whose target is
that branch controls the decision. A label on an earlier development PR does not
carry over to a later promotion PR. Labels are read when the Release intent job
runs; editing them later does not change an already-running publication. API
lookup errors or an unidentified merged PR block publication. Re-running the full
workflow reads labels again.

Successful prerelease verification remains reusable even when publication was
intentionally skipped: its full matrix still ran. This lets CI/documentation
maintenance avoid a beta publication without losing verification evidence.

## One-time setup

1. Bootstrap the public `@hyper3d/cli` package with an authorized npm account if
   needed. The placeholder `0.0.1` is separate from the first functional release.
2. Configure npm trusted publishing for GitHub owner `DeemosTech`, repository
   `hyper3d-cli`, workflow filename `release.yml`, and environment `npm`. Allow
   direct `npm publish`. No long-lived npm token is needed. See
   [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
3. The GitHub `npm` environment can be created ahead of time or automatically on
   first use. If branch restrictions are configured, allow both `main` and
   `prerelease`. Do not require environment reviewers for unattended publication.
4. Require PRs and current passing `Release policy` and `CI checks` on both release
   branches. The helper below configures these checks, resolved conversations,
   zero mandatory human approvals, and no force pushes/deletion, including for
   administrators. Review existing protection before applying it because this
   replaces that configuration:

```sh
node scripts/protect-branches.mjs
```

## Verify and recover

Check Actions, npm dist-tags, and the GitHub Release after the first publication.
Install beta explicitly with `npm install -g @hyper3d/cli@beta`; ordinary
`npm install -g @hyper3d/cli` follows `latest`. Beta installations track beta
updates; users switch to stable explicitly with `@latest`.

npm versions are immutable. A retry of a successful stable publication is rejected.
If npm publication succeeds but GitHub Release creation fails, use the existing
workflow artifact and exact release commit to create the missing tag/release;
do not republish or move an existing tag. An already-existing stable tag also
blocks publication before npm is changed. A rerun of a beta workflow gets a new
attempt suffix, provided its planned version is still above main and latest.

Before releasing, verify CLI login using Device Flow and the public CIMD client metadata.
See [architecture.md](architecture.md) for authentication and compatibility details.
