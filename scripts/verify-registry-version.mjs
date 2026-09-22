import { readFile } from 'node:fs/promises';
import semver from 'semver';
import { assertStableVersion } from './release-policy.mjs';

export function verifyRegistryVersion(version, channel, metadata) {
  if (channel === 'latest') assertStableVersion(version);
  else if (
    channel !== 'beta' ||
    !semver.valid(version) ||
    !/^\d+\.\d+\.\d+-beta\.[1-9]\d*\.[1-9]\d*$/.test(version)
  )
    throw new Error('Invalid beta release version or channel');
  if (metadata.versions?.[version])
    throw new Error(
      `${version} is already published. Recover the existing release instead of republishing.`,
    );
  const current = metadata['dist-tags']?.[channel];
  if (current && !semver.gt(version, current))
    throw new Error(
      `Refusing to move ${channel} backwards from ${current} to ${version}`,
    );
  const stable = metadata['dist-tags']?.latest;
  if (channel === 'beta' && stable && !semver.gt(version, stable))
    throw new Error('Beta must be newer than the published stable version');
}

if (process.argv[1]?.endsWith('verify-registry-version.mjs')) {
  const pkg = JSON.parse(await readFile('packages/cli/package.json', 'utf8'));
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok && response.status !== 404)
    throw new Error(`Cannot verify npm versions: HTTP ${response.status}`);
  verifyRegistryVersion(
    pkg.version,
    process.env.RELEASE_CHANNEL,
    response.status === 404 ? {} : await response.json(),
  );
}
