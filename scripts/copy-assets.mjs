import { copyFile, chmod } from 'node:fs/promises';
await copyFile(
  new URL('../packages/cli/src/base_schema.json', import.meta.url),
  new URL('../packages/cli/dist/base_schema.json', import.meta.url),
);
try {
  await copyFile(
    new URL('../packages/cli/src/canary_schema.json', import.meta.url),
    new URL('../packages/cli/dist/canary_schema.json', import.meta.url),
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await chmod(new URL('../packages/cli/dist/index.js', import.meta.url), 0o755);
