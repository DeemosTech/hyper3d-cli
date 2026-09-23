import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function shouldSkipRelease(pulls, { sha, branch, repository }) {
  const merged = pulls.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === sha &&
      pr.base.ref === branch &&
      pr.base.repo.full_name === repository,
  );
  if (merged.length !== 1)
    throw new Error('Cannot uniquely identify the PR merged by this push');
  return merged[0].labels.some((label) => label.name === 'skip-release');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const sha = process.env.GITHUB_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME;
  // Read every page: a commit can be associated with multiple promotion PRs.
  // API errors deliberately fail this job, preventing accidental publication.
  const pages = JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository}/commits/${sha}/pulls?per_page=100`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    ),
  );
  const skip = shouldSkipRelease(pages.flat(), { sha, branch, repository });
  appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\n`);
  const message = skip
    ? 'skip-release: verification continues; npm publication and GitHub Release are skipped.'
    : 'No skip-release label on the PR merged by this push; publication is enabled.';
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}
