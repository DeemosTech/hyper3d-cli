import { copyFile, chmod } from 'node:fs/promises';
await copyFile(
  new URL('../packages/cli/src/base_schema.json', import.meta.url),
  new URL('../packages/cli/dist/base_schema.json', import.meta.url),
);
await chmod(new URL('../packages/cli/dist/index.js', import.meta.url), 0o755);
