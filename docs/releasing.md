# Release operations

## Release channels

| Trigger                | npm version                                                  | npm dist-tag | GitHub release |
| ---------------------- | ------------------------------------------------------------ | ------------ | -------------- |
| Merge a PR into `main` | Next patch of package base, suffixed `-next.<run>.<attempt>` | `next`       | No             |
| Push `vX.Y.Z`          | Exact `packages/cli/package.json` version                    | `latest`     | Yes            |

For example, with base `0.1.0`, main run 23 attempt 1 publishes
`0.1.1-next.23.1`. A `v0.1.0` tag publishes `0.1.0`. Tags must match the stable
package version and point to a commit reachable from main. Bump versions through
PRs, including the lockfile. Use increasing stable versions; never retag a release
or publish an older version as `latest`.

`.github/workflows/release.yml` calls the full cross-platform CI workflow before
publishing. Publications are serialized. Each release validates its version,
smoke-tests installation, uploads an npm tarball artifact, publishes with npm OIDC
provenance, and creates a GitHub release for stable tags. Development-branch pushes
and PRs only run CI.

## One-time setup (not yet applied)

1. Confirm ownership of the npm `@hyper3d` scope and package name. Bootstrap the
   initial public package with an authorized npm account if needed. The source is
   publishable now, but no package is published merely by installing dependencies.
2. Configure the package's npm trusted publisher for GitHub owner `DeemosTech`,
   repository `hyper3d-cli`, workflow `release.yml`, environment `npm`, allowing
   publishing. The workflow uses Node.js 24 and npm with OIDC support, so no
   long-lived npm token is required. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
3. Create the GitHub environment `npm`. While manually reviewing this rollout,
   configure required reviewers before enabling releases. The environment must
   allow main and version tags. Do not push main or tags until publishing is ready.
4. Apply main protection using the reviewed script below. It requires PRs, one
   approving review, current passing `CI checks`, resolved conversations, and
   forbids force pushes/deletion. Run only after the CI workflow has reported the
   check once. The script updates existing protection, so review current settings
   before applying it.

```sh
node scripts/protect-main.mjs
```

The current task intentionally leaves remote configuration, pushes, tags and
publishing for manual review. Default branch is already `main`.

## Stable release

1. Create a branch, update package version and lockfile, and review the release.
2. Merge the PR after CI and human approval. This publishes a `next` build.
3. After verifying the commit and package, create and push the matching tag:

```sh
git switch main
git pull --ff-only
# Replace X.Y.Z with the package version reviewed in the PR.
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

Check Actions, the npm artifact and GitHub release. npm versions are immutable.
If publishing succeeds but GitHub release creation fails, create the GitHub release
from the existing tag and workflow artifact; do not republish that npm version.

## Compatibility policy and authentication

`release-policy/stable.json` is an independent minimum-version policy. Host it over
HTTPS and set `HYPER3D_RELEASE_POLICY_URL` or the package's
`hyper3d.releasePolicyUrl` to enable it. No production policy URL is configured.
Keep forced upgrades separate from normal releases. Network or invalid-policy
errors warn and allow continuing; valid minimum-version failures block model
operations but leave authentication and updates available.

Before releasing, verify the deployed Device Flow and official CIMD client metadata.
See [architecture.md](architecture.md) for the backend integration contract.
