import { readFile } from 'node:fs/promises';
import semver from 'semver';

// Prevent a late or repeated release from moving an npm channel backwards.
const pkg = JSON.parse(await readFile('packages/cli/package.json', 'utf8'));
const channel = process.env.RELEASE_CHANNEL;
if (!['latest', 'next'].includes(channel))
  throw new Error('Invalid release channel');
const response = await fetch(
  `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`,
  {
    signal: AbortSignal.timeout(15000),
  },
);
if (response.status !== 404) {
  if (!response.ok)
    throw new Error(`Cannot verify npm versions: HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.versions?.[pkg.version])
    throw new Error(
      `${pkg.version} is already published. Recover the existing release instead of republishing.`,
    );
  const current = metadata['dist-tags']?.[channel];
  if (current && !semver.gt(pkg.version, current))
    throw new Error(
      `Refusing to move ${channel} backwards from ${current} to ${pkg.version}`,
    );
}
