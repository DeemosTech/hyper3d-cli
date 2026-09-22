import { readFileSync } from 'node:fs';
import semver from 'semver';
import { readVersionAt, checkPullRequest } from './release-policy.mjs';

const mergedVersion = readVersionAt('HEAD');
if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
  const { pull_request: pr } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'),
  );
  for (const sha of [pr.head.sha, pr.base.sha]) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid PR commit SHA');
  }
  const mainVersion = readVersionAt('refs/remotes/origin/main', {
    allowBootstrap: true,
  });
  checkPullRequest({
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    sameRepository: pr.head.repo?.full_name === pr.base.repo.full_name,
    headVersion: readVersionAt(pr.head.sha),
    baseVersion: readVersionAt(pr.base.sha, { allowBootstrap: true }),
    mainVersion,
    mergedVersion,
  });
  console.log(`Release policy passed: ${pr.head.ref} -> ${pr.base.ref}`);
} else if (process.env.GITHUB_REF === 'refs/heads/prerelease') {
  const mainVersion = readVersionAt('refs/remotes/origin/main', {
    allowBootstrap: true,
  });
  if (!semver.gt(mergedVersion, mainVersion))
    throw new Error(
      'Bump the prerelease target version above main before publishing beta',
    );
  console.log(`Beta target ${mergedVersion} is newer than main ${mainVersion}`);
} else {
  console.log(`Source package and lockfile versions match: ${mergedVersion}`);
}
