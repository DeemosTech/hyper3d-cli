import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseVersion } from '../scripts/release-version.mjs';
import {
  assertStableVersion,
  readVersionAt,
  checkPullRequest,
} from '../scripts/release-policy.mjs';
import { verifyRegistryVersion } from '../scripts/verify-registry-version.mjs';

test('prerelease publishes beta of the planned version; main publishes that exact stable version', () => {
  assert.deepEqual(
    releaseVersion('0.1.0', 'refs/heads/prerelease', '23', '2'),
    {
      version: '0.1.0-beta.23.2',
      channel: 'beta',
    },
  );
  assert.deepEqual(releaseVersion('0.1.0', 'refs/heads/main'), {
    version: '0.1.0',
    channel: 'latest',
  });
  for (const ref of [
    'refs/heads/dev/feature',
    'refs/tags/v0.1.0',
    'refs/tags/v0.1.0-beta.1',
  ])
    assert.throws(() => releaseVersion('0.1.0', ref));
  for (const run of ['bad', '0', '01', '-1'])
    assert.throws(() =>
      releaseVersion('0.1.0', 'refs/heads/prerelease', run, '1'),
    );
  assert.throws(() =>
    releaseVersion('0.1.0', 'refs/heads/prerelease', '1', 'bad'),
  );
});

test('source versions must be canonical stable semver', () => {
  assert.equal(assertStableVersion('1.10.0'), '1.10.0');
  for (const version of [
    undefined,
    '',
    'v1.0.0',
    '1.0',
    '1.0.0-beta.1',
    '1.0.0+build.1',
  ])
    assert.throws(() => assertStableVersion(version));
});

const promotion = {
  baseBranch: 'main',
  headBranch: 'prerelease',
  sameRepository: true,
  headVersion: '0.2.0',
  baseVersion: '0.1.0',
  mainVersion: '0.1.0',
  mergedVersion: '0.2.0',
};

test('main requires a strictly newer version from the same repository prerelease branch', () => {
  assert.doesNotThrow(() => checkPullRequest(promotion));
  for (const change of [
    { baseVersion: '0.2.0' },
    { baseVersion: '0.3.0' },
    { headBranch: 'dev/feature' },
    { sameRepository: false },
    { mergedVersion: '0.3.0' },
    { baseBranch: 'other' },
  ])
    assert.throws(() => checkPullRequest({ ...promotion, ...change }));
});

test('development may equal prerelease, but must stay above main after a stable promotion', () => {
  const development = {
    ...promotion,
    baseBranch: 'prerelease',
    headBranch: 'dev/feature',
    baseVersion: '0.2.0',
  };
  assert.doesNotThrow(() => checkPullRequest(development));
  assert.doesNotThrow(() =>
    checkPullRequest({
      ...development,
      headVersion: '0.10.0',
      mergedVersion: '0.10.0',
    }),
  );
  for (const change of [
    { baseVersion: '0.3.0' },
    { mainVersion: '0.2.0' },
    { headBranch: 'main' },
    { headBranch: 'prerelease' },
    { mergedVersion: '0.3.0' },
  ])
    assert.throws(() => checkPullRequest({ ...development, ...change }));
});

test('only the two-file root can bootstrap without a version; real commits require a synchronized lockfile', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hyper3d-policy-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    );
  };
  try {
    git('init');
    writeFileSync(join(cwd, 'README.md'), '# CLI\n');
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n');
    commit();
    assert.equal(readVersionAt('HEAD', { cwd, allowBootstrap: true }), '0.0.0');
    assert.throws(() => readVersionAt('HEAD', { cwd }), /missing/);
    writeFileSync(join(cwd, 'README.md'), '# Changed\n');
    commit();
    assert.throws(
      () => readVersionAt('HEAD', { cwd, allowBootstrap: true }),
      /missing/,
    );
    mkdirSync(join(cwd, 'packages/cli'), { recursive: true });
    writeFileSync(
      join(cwd, 'packages/cli/package.json'),
      JSON.stringify({ name: '@hyper3d/cli', version: '0.1.0' }),
    );
    const lock = (version) =>
      writeFileSync(
        join(cwd, 'package-lock.json'),
        JSON.stringify({ packages: { 'packages/cli': { version } } }),
      );
    lock('0.1.0');
    commit();
    assert.equal(readVersionAt('HEAD', { cwd }), '0.1.0');
    lock('0.2.0');
    commit();
    assert.throws(() => readVersionAt('HEAD', { cwd }), /versions differ/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('registry guards reject duplicates, channel rollback and beta for an already stable version', () => {
  const metadata = {
    versions: { '0.1.0': {} },
    'dist-tags': { latest: '0.1.0', beta: '0.2.0-beta.23.1' },
  };
  assert.doesNotThrow(() =>
    verifyRegistryVersion('0.2.0-beta.24.1', 'beta', metadata),
  );
  assert.doesNotThrow(() => verifyRegistryVersion('0.2.0', 'latest', metadata));
  assert.doesNotThrow(() =>
    verifyRegistryVersion('0.1.0-beta.1.1', 'beta', {}),
  );
  for (const [version, channel] of [
    ['0.1.0', 'latest'],
    ['0.0.9', 'latest'],
    ['0.2.0-beta.22.1', 'beta'],
    ['0.2.0', 'beta'],
    ['0.2.0-beta.24.1', 'latest'],
    ['0.2.0', 'next'],
  ])
    assert.throws(() => verifyRegistryVersion(version, channel, metadata));
  assert.throws(() =>
    verifyRegistryVersion('0.1.0-beta.99.1', 'beta', {
      'dist-tags': { latest: '0.1.0' },
    }),
  );
});
