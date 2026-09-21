import { execFileSync } from 'node:child_process';
const protection = {
  required_status_checks: { strict: true, contexts: ['CI checks'] },
  enforce_admins: true,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    required_approving_review_count: 1,
  },
  restrictions: null,
  required_conversation_resolution: true,
  allow_force_pushes: false,
  allow_deletions: false,
};
execFileSync(
  'gh',
  [
    'api',
    '--method',
    'PUT',
    'repos/DeemosTech/hyper3d-cli/branches/main/protection',
    '--input',
    '-',
  ],
  {
    input: JSON.stringify(protection),
    stdio: ['pipe', 'inherit', 'inherit'],
  },
);
