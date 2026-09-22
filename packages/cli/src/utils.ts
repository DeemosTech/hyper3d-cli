import { homedir } from 'node:os';
import { join } from 'node:path';

export function getConfigDir() {
  return process.env.HYPER3D_CONFIG_DIR ?? join(homedir(), '.hyper3d');
}

export function omitUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}
