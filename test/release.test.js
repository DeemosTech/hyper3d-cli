import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseVersion } from '../scripts/release-version.mjs';
test('main publishes a unique next version and stable tags must match package version', () => {
  assert.deepEqual(releaseVersion('0.1.0', 'refs/heads/main', '23', '2'), {
    version: '0.1.1-next.23.2',
    channel: 'next',
  });
  assert.deepEqual(releaseVersion('0.1.0', 'refs/tags/v0.1.0'), {
    version: '0.1.0',
    channel: 'latest',
  });
  for (const ref of [
    'refs/heads/feature',
    'refs/tags/v0.2.0',
    'refs/tags/0.1.0',
    'refs/tags/v0.1.0-beta.1',
  ])
    assert.throws(() => releaseVersion('0.1.0', ref));
  assert.throws(() => releaseVersion('0.1.0', 'refs/heads/main', 'bad', '1'));
});
