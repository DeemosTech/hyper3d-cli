import { execFileSync } from 'node:child_process';
import semver from 'semver';

export function assertStableVersion(version) {
  if (
    typeof version !== 'string' ||
    semver.valid(version) !== version ||
    semver.prerelease(version) ||
    semver.parse(version).build.length
  )
    throw new Error(
      `Expected a stable X.Y.Z source version, received ${version}`,
    );
  return version;
}

export function readVersionAt(ref, { cwd, allowBootstrap = false } = {}) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const files = git('ls-tree', '-r', '--name-only', ref).split('\n');
  if (
    allowBootstrap &&
    files.join('\n') === '.gitignore\nREADME.md' &&
    git('rev-list', '--count', ref) === '1'
  )
    return '0.0.0';
  if (!files.includes('packages/cli/package.json'))
    throw new Error(`${ref} is missing packages/cli/package.json`);
  const pkg = JSON.parse(git('show', `${ref}:packages/cli/package.json`));
  const lock = JSON.parse(git('show', `${ref}:package-lock.json`));
  assertStableVersion(pkg.version);
  if (pkg.name !== '@hyper3d/cli') throw new Error('Unexpected package name');
  if (lock.packages?.['packages/cli']?.version !== pkg.version)
    throw new Error(
      `${ref}: package.json and package-lock.json versions differ`,
    );
  return pkg.version;
}

export function checkPullRequest({
  baseBranch,
  headBranch,
  sameRepository,
  headVersion,
  baseVersion,
  mainVersion,
  mergedVersion,
}) {
  for (const version of [headVersion, baseVersion, mainVersion, mergedVersion])
    assertStableVersion(version);
  if (mergedVersion !== headVersion)
    throw new Error('The merge result must retain the source branch version');
  if (baseBranch === 'main') {
    if (headBranch !== 'prerelease' || !sameRepository)
      throw new Error(
        "Only this repository's prerelease branch may target main",
      );
    if (!semver.gt(headVersion, baseVersion))
      throw new Error('prerelease version must be greater than main');
  } else if (baseBranch === 'prerelease') {
    if (headBranch === 'main' || headBranch === 'prerelease')
      throw new Error('Use a development branch to target prerelease');
    if (!semver.gte(headVersion, baseVersion))
      throw new Error('Development version must be >= prerelease');
    if (!semver.gt(headVersion, mainVersion))
      throw new Error(
        'The resulting prerelease version must be greater than main',
      );
  } else {
    throw new Error('Pull requests must target main or prerelease');
  }
}
