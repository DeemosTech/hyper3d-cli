import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipRelease } from '../scripts/release-intent.mjs';

const context = {
  sha: 'a'.repeat(40),
  branch: 'prerelease',
  repository: 'example/cli',
};
const merged = {
  merged_at: '2026-09-24T00:00:00Z',
  merge_commit_sha: context.sha,
  base: { ref: 'prerelease', repo: { full_name: context.repository } },
  labels: [{ name: 'skip-release' }],
};

test('skip-release suppresses publication on either release branch', () => {
  for (const branch of ['main', 'prerelease'])
    assert.equal(
      shouldSkipRelease(
        [{ ...merged, base: { ...merged.base, ref: branch } }],
        { ...context, branch },
      ),
      true,
    );
  assert.throws(() => shouldSkipRelease([], context), /identify/);
  assert.throws(() => shouldSkipRelease([merged, merged], context), /identify/);
  assert.equal(shouldSkipRelease([{ ...merged, labels: [] }], context), false);
});

test('labels on unrelated, open, or earlier-stage PRs cannot suppress this release', () => {
  for (const change of [
    { merged_at: null },
    { merge_commit_sha: 'b'.repeat(40) },
    { base: { ...merged.base, ref: 'main' } },
    { base: { ref: 'prerelease', repo: { full_name: 'fork/cli' } } },
  ])
    assert.throws(
      () => shouldSkipRelease([{ ...merged, ...change }], context),
      /identify/,
    );
  assert.equal(
    shouldSkipRelease([{ ...merged, labels: [{ name: 'skip-ci' }] }], context),
    false,
  );
  const stable = { ...context, branch: 'main', sha: 'c'.repeat(40) };
  const promotion = {
    ...merged,
    merge_commit_sha: stable.sha,
    base: { ...merged.base, ref: 'main' },
    labels: [],
  };
  assert.equal(shouldSkipRelease([merged, promotion], stable), false);
  assert.equal(
    shouldSkipRelease(
      [merged, { ...promotion, labels: merged.labels }],
      stable,
    ),
    true,
  );
});
