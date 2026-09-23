import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function promotionCandidate({ eventName, event, ref, repository, git }) {
  const pr = event.pull_request;
  if (
    eventName === 'pull_request' &&
    pr?.base.ref === 'main' &&
    pr.head.ref === 'prerelease' &&
    pr.head.repo?.full_name === repository &&
    pr.base.repo.full_name === repository
  )
    return pr.head.sha;
  if (eventName === 'push' && ref === 'refs/heads/main') {
    // A regular promotion merge keeps the tested prerelease as its second parent.
    // Squash/rebase merges safely fall back to the full matrix.
    const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
    if (parents.length === 3) return parents[2];
  }
  return undefined;
}

export async function canReusePrerelease({ candidate, git, listRuns }) {
  if (!candidate || !/^[a-f0-9]{40}$/.test(candidate)) return false;
  if (
    git('rev-parse', 'HEAD^{tree}') !== git('rev-parse', `${candidate}^{tree}`)
  )
    return false;
  const runs = await listRuns(candidate);
  return runs.some(
    (run) =>
      run.head_sha === candidate &&
      run.head_branch === 'prerelease' &&
      run.event === 'push' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.path === '.github/workflows/release.yml',
  );
}

export async function selectVerification(options) {
  try {
    return await canReusePrerelease({
      ...options,
      candidate: promotionCandidate(options),
    });
  } catch (error) {
    // Missing history, API failures and unavailable evidence must never skip CI.
    console.warn(`Cannot reuse prerelease verification: ${error.message}`);
    return false;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const repository = process.env.GITHUB_REPOSITORY;
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8' }).trim();
  const reuse = await selectVerification({
    eventName: process.env.GITHUB_EVENT_NAME,
    event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    ref: process.env.GITHUB_REF,
    repository,
    git,
    listRuns: async (sha) => {
      const url = new URL(
        `/repos/${repository}/actions/workflows/release.yml/runs`,
        process.env.GITHUB_API_URL || 'https://api.github.com',
      );
      url.search = new URLSearchParams({
        branch: 'prerelease',
        event: 'push',
        head_sha: sha,
        per_page: '100',
      }).toString();
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(`GitHub API returned ${response.status}`);
      return (await response.json()).workflow_runs;
    },
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${reuse}\n`);
  console.log(
    reuse
      ? 'Reusing successful prerelease verification: the entire Git tree is identical.'
      : 'Running full verification: no identical, successfully verified prerelease.',
  );
}
