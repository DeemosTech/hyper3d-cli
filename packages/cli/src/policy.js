import semver from 'semver';

export function evaluatePolicy(policy, version) {
  if (policy.schemaVersion !== 1 || !semver.valid(policy.minimumVersion))
    throw new Error('Invalid release policy');
  return {minimumVersion: policy.minimumVersion, required: semver.lt(version, policy.minimumVersion)};
}

export async function enforcePolicy(url, version, fetchFn = fetch) {
  if (!url) return;
  if (new URL(url).protocol !== 'https:') throw new Error('Release policy must use HTTPS');
  let decision;
  try {
    const response = await fetchFn(url, {signal: AbortSignal.timeout(3000), redirect: 'error'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    decision = evaluatePolicy(await response.json(), version);
  } catch {
    process.stderr.write('warning: Update policy unavailable; continuing without a version decision.\n');
    return;
  }
  if (decision.required) throw new Error(`CLIENT_UPGRADE_REQUIRED: minimum CLI version is ${decision.minimumVersion}. Run hyper3d update.`);
}
