import { randomBytes, randomUUID } from 'node:crypto';

import { schemaFor } from './schema.js';

import type { SchemaVersion } from './schema.js';

export type UploadKind = 'image' | 'animation' | 'model';

const contracts = {
  default: {
    maxBytes: { image: 20 * 1024 ** 2, animation: 25 * 1024 ** 2, model: 0 },
    placeholderId: randomUUID,
    requiresContentType: true,
    supportsImage: () => true,
    declaration: (filename: string, mime: string, size: number) => ({
      filename,
      mime_type: mime,
      size_bytes: size,
    }),
  },
  canary: {
    maxBytes: {
      image: 25 * 1024 ** 2,
      animation: 25 * 1024 ** 2,
      model: 128 * 1024 ** 2,
    },
    placeholderId: () => randomBytes(16).toString('base64url'),
    requiresContentType: false,
    supportsImage: (extension: string) =>
      [
        '.jpg',
        '.jpeg',
        '.png',
        '.webp',
        '.gif',
        '.tif',
        '.tiff',
        '.avif',
        '.heic',
        '.heif',
      ].includes(extension),
    declaration: (filename: string, _mime: string, size: number) => ({
      filename,
      size_bytes: size,
    }),
  },
};

export function uploadContract(version: SchemaVersion = 'default') {
  schemaFor(version);
  return contracts[version];
}
