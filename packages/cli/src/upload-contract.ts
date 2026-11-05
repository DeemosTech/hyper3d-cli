import { randomBytes } from 'node:crypto';

export type UploadKind = 'image' | 'animation' | 'model';

export const uploadContract = {
  maxBytes: {
    image: 25 * 1024 ** 2,
    animation: 25 * 1024 ** 2,
    model: 128 * 1024 ** 2,
  },
  placeholderId: () => randomBytes(16).toString('base64url'),
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
  declaration: (filename: string, size: number) => ({
    filename,
    size_bytes: size,
  }),
};
