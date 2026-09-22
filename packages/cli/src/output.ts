import type { Payload } from './types.js';
const initialisms = new Map([
  ['api', 'API'],
  ['cli', 'CLI'],
  ['id', 'ID'],
  ['mime', 'MIME'],
  ['url', 'URL'],
  ['uuid', 'UUID'],
]);

function label(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => initialisms.get(word.toLowerCase()) ?? word.toLowerCase());
  if (!words.length) return key;
  if (!initialisms.has(words[0].toLowerCase()))
    words[0] = `${words[0][0].toUpperCase()}${words[0].slice(1)}`;
  return words.join(' ');
}

function scalar(value: unknown) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function scalarLine(
  prefix: string,
  value: unknown,
  continuationIndent: number,
) {
  const lines = scalar(value).split('\n');
  return [
    `${prefix}${lines[0]}`,
    ...lines.slice(1).map((line) => `${' '.repeat(continuationIndent)}${line}`),
  ];
}

function renderEntry(key: string, value: unknown, indent: number): string[] {
  const padding = ' '.repeat(indent);
  const prefix = `${padding}${label(key)}:`;
  if (!value || typeof value !== 'object')
    return scalarLine(`${prefix} `, value, prefix.length + 1);
  if (Array.isArray(value))
    return value.length
      ? [prefix, ...renderArray(value, indent + 2)]
      : [`${prefix} None`];
  const entries = Object.entries(value);
  return entries.length
    ? [prefix, ...renderObject(value, indent + 2)]
    : [`${prefix} None`];
}

function renderObject(value: object, indent = 0): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    renderEntry(key, child, indent),
  );
}

function renderArray(value: unknown[], indent = 0): string[] {
  const padding = ' '.repeat(indent);
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object')
      return scalarLine(`${padding}- `, item, indent + 2);
    if (Array.isArray(item))
      return [`${padding}-`, ...renderArray(item, indent + 2)];
    const entries = Object.entries(item);
    if (!entries.length) return [`${padding}- None`];
    const [[firstKey, firstValue], ...rest] = entries;
    if (!firstValue || typeof firstValue !== 'object') {
      const firstPrefix = `${padding}- ${label(firstKey)}: `;
      return [
        ...scalarLine(firstPrefix, firstValue, firstPrefix.length),
        ...rest.flatMap(([key, child]) => renderEntry(key, child, indent + 2)),
      ];
    }
    return [
      `${padding}- ${label(firstKey)}:`,
      ...(Array.isArray(firstValue)
        ? renderArray(firstValue, indent + 4)
        : renderObject(firstValue, indent + 4)),
      ...rest.flatMap(([key, child]) => renderEntry(key, child, indent + 2)),
    ];
  });
}

function formatAccount(value: Payload) {
  if (!value.authenticated) return 'Not authenticated. Run hyper3d auth login.';
  const workspace =
    value.wallet.type === 'group'
      ? `${value.wallet.name || 'Team'} (${value.wallet.group_uuid})`
      : 'Personal';
  const lines = [
    `Authenticated as ${value.user.username}`,
    `User ID: ${value.user.uuid}`,
    `Workspace: ${workspace}`,
    'Credits:',
    `  Regular: ${scalar(value.wallet.balance)}`,
  ];
  if (value.wallet.type === 'personal')
    lines.push(`  Subscription: ${scalar(value.wallet.subscription_balance)}`);
  lines.push(`  Frozen: ${scalar(value.wallet.frozen)}`);
  return lines.join('\n');
}

function formatHuman(value: Payload, kind?: string) {
  if (kind === 'auth-login') return 'Authenticated successfully.';
  if (kind === 'auth-logout') return 'Local credentials removed.';
  if (kind === 'account') return formatAccount(value);
  if (!value || typeof value !== 'object') return scalar(value);
  if (Array.isArray(value)) return renderArray(value).join('\n');
  const displayed =
    value.stage && typeof value.stage === 'object'
      ? {
          ...value,
          stage: `${value.stage.name} (${value.stage.current}/${value.stage.total})`,
        }
      : value;
  return renderObject(displayed).join('\n');
}

export function formatOutput(
  value: Payload,
  { format = 'human', kind }: { format?: string; kind?: string } = {},
) {
  if (format === 'json') return JSON.stringify(value, null, 2);
  if (format === 'human') return formatHuman(value, kind);
  throw new Error(`Unsupported output format: ${format}`);
}
