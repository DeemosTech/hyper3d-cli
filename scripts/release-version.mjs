import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { assertStableVersion } from './release-policy.mjs';
export function releaseVersion(base, ref, run, attempt) {
  assertStableVersion(base);
  if (ref === 'refs/heads/prerelease') {
    if (!/^[1-9]\d*$/.test(run) || !/^[1-9]\d*$/.test(attempt))
      throw new Error('Invalid workflow run identity');
    return {
      version: `${base}-beta.${run}.${attempt}`,
      channel: 'beta',
    };
  }
  if (ref !== 'refs/heads/main')
    throw new Error('Only main and prerelease can publish');
  return { version: base, channel: 'latest' };
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
