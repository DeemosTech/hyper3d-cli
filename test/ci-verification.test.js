import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  promotionCandidate,
  selectVerification,
} from '../scripts/ci-verification.mjs';

const repository = 'example/cli';
const sha = 'a'.repeat(40);
const promotion = (candidate = sha) => ({
  eventName: 'pull_request',
  repository,
  event: {
    pull_request: {
      base: { ref: 'main', repo: { full_name: repository } },
      head: {
        ref: 'prerelease',
        sha: candidate,
        repo: { full_name: repository },
      },
    },
  },
});
const successfulBeta = (candidate) => ({
  head_sha: candidate,
  head_branch: 'prerelease',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  path: '.github/workflows/release.yml',
});

test('only same-repository promotion PRs and main merge pushes can reuse beta', () => {
  assert.equal(promotionCandidate(promotion()), sha);
  for (const change of [
    { base: { ref: 'prerelease', repo: { full_name: repository } } },
    { head: { ref: 'feature', sha, repo: { full_name: repository } } },
    { head: { ref: 'prerelease', sha, repo: { full_name: 'fork/cli' } } },
  ]) {
    const options = promotion();
    Object.assign(options.event.pull_request, change);
    assert.equal(promotionCandidate(options), undefined);
  }
  for (const [eventName, ref] of [
    ['push', 'refs/heads/prerelease'],
    ['workflow_dispatch', 'refs/heads/main'],
  ])
    assert.equal(promotionCandidate({ eventName, event: {}, ref }), undefined);
  const push = { eventName: 'push', event: {}, ref: 'refs/heads/main' };
  assert.equal(
    promotionCandidate({ ...push, git: () => `merge main ${sha}` }),
    sha,
  );
  assert.equal(
    promotionCandidate({ ...push, git: () => 'squash main' }),
    undefined,
  );
});

test('unavailable, incomplete or unrelated release evidence falls back to full tests', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const options = { ...promotion(), git: () => 'identical tree' };
  for (const change of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'main' },
    { event: 'pull_request' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { conclusion: 'skipped' },
    { path: '.github/workflows/ci.yml' },
  ])
    assert.equal(
      await selectVerification({
        ...options,
        listRuns: async () => [{ ...successfulBeta(sha), ...change }],
      }),
      false,
    );
  for (const listRuns of [
    async () => [],
    async () => undefined,
    async () => {
      throw new Error('API unavailable');
    },
  ])
    assert.equal(await selectVerification({ ...options, listRuns }), false);
  assert.equal(
    await selectVerification({
      ...options,
      git: () => {
        throw new Error('Missing commit');
      },
    }),
    false,
  );
  assert.equal(
    await selectVerification({
      ...promotion('--bad-ref'),
      git: () => assert.fail(),
    }),
    false,
  );
});

test('promotion reuses the exact beta commit only when the entire merge tree matches', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hyper3d-ci-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    const commit = (file, content) => {
      writeFileSync(join(cwd, file), content);
      git('add', '.');
      git('commit', '-m', 'fixture');
    };
    commit('README.md', 'base');
    git('checkout', '-b', 'prerelease');
    commit('cli.js', 'tested code');
    const candidate = git('rev-parse', 'HEAD');
    git('checkout', 'main');
    git('merge', '--no-ff', 'prerelease', '-m', 'promote');
    assert.notEqual(git('rev-parse', 'HEAD'), candidate);
    const listRuns = async (requested) => {
      assert.equal(requested, candidate);
      return [successfulBeta(candidate)];
    };
    for (const event of [
      promotion(candidate),
      { eventName: 'push', event: {}, ref: 'refs/heads/main' },
    ])
      assert.equal(await selectVerification({ ...event, git, listRuns }), true);

    // Even documentation/config changes invalidate reuse, not just source edits.
    commit('README.md', 'extra main content');
    assert.equal(
      await selectVerification({
        ...promotion(candidate),
        git,
        listRuns: () =>
          assert.fail('Do not query evidence for a different tree'),
      }),
      false,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
