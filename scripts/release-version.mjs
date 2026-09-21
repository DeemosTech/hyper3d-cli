import semver from 'semver';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
export function releaseVersion(base, ref, run, attempt) {
  if (!semver.valid(base) || semver.prerelease(base))
    throw new Error('package.json must contain a stable base version');
  if (ref === 'refs/heads/main') {
    if (!/^\d+$/.test(run) || !/^\d+$/.test(attempt))
      throw new Error('Invalid workflow run identity');
    return {
      version: `${semver.inc(base, 'patch')}-next.${run}.${attempt}`,
      channel: 'next',
    };
  }
  const version = ref.replace(/^refs\/tags\/v/, '');
  if (
    ref !== `refs/tags/v${version}` ||
    !semver.valid(version) ||
    version !== base
  )
    throw new Error('Release tag must be v<package.json version>');
  return { version, channel: 'latest' };
}
if (process.argv[1]?.endsWith('release-version.mjs')) {
  const path = 'packages/cli/package.json';
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const result = releaseVersion(
    pkg.version,
    process.env.GITHUB_REF,
    process.env.GITHUB_RUN_NUMBER,
    process.env.GITHUB_RUN_ATTEMPT,
  );
  if (result.channel === 'latest') {
    execFileSync('git', ['fetch', 'origin', 'main']);
    execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
  }
  pkg.version = result.version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  lock.packages['packages/cli'].version = result.version;
  writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\nchannel=${result.channel}\n`,
    );
}
