import { rm } from 'node:fs/promises';

await rm(new URL('../packages/cli/dist/', import.meta.url), {
  recursive: true,
  force: true,
});
