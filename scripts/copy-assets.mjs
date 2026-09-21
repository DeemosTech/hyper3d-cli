import { cp, chmod } from 'node:fs/promises';
await cp(
  new URL('../packages/cli/src/contracts/', import.meta.url),
  new URL('../packages/cli/dist/contracts/', import.meta.url),
  { recursive: true, filter: (source) => !source.endsWith('.ts') },
);
await chmod(new URL('../packages/cli/dist/index.js', import.meta.url), 0o755);
