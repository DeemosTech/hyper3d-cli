import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import {
  rodinCreateUploads,
  rodinGenerate,
  rodinGenerateBang,
  rodinGetStatus,
  rodinGetResult,
  rodinWait,
  validateGenerate,
  withToolContext,
} from './mcp.js';
import { omitUndefined } from './utils.js';

import type { ToolContext } from './mcp.js';
import type { GenerateOptions } from './types.js';

const mimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.jp2': 'image/jp2',
  '.jpx': 'image/jpx',
  '.jpm': 'image/jpm',
  '.mj2': 'image/mj2',
};
const defaultPollTimeoutSeconds = 30;
// Leave ample headroom under the MCP client's 60-second per-request timeout.
const maximumWaitCallSeconds = 30;

export async function poll(
  generationId: string,
  timeoutSeconds = defaultPollTimeoutSeconds,
  context?: ToolContext,
) {
  return withToolContext(async (context) => {
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1)
      throw new Error(
        'Poll timeout must be a positive integer number of seconds',
      );
    let remainingSeconds = timeoutSeconds;
    let latest;
    do {
      const waitSeconds = Math.min(remainingSeconds, maximumWaitCallSeconds);
      latest = await rodinWait(context, {
        generation_id: generationId,
        timeout_seconds: waitSeconds,
      });
      if (latest.timed_out !== true) return latest;
      remainingSeconds -= waitSeconds;
    } while (remainingSeconds > 0);
    return latest;
  }, context);
}

export async function generate(
  options: GenerateOptions,
  context?: ToolContext,
) {
  return withToolContext(async (context) => {
    const paths = options.image ?? [];
    if (paths.length > 5) throw new Error('Provide at most five images');
    if (!paths.length && !options.prompt?.trim())
      throw new Error('Provide --prompt or --image');
    const input = omitUndefined({
      prompt: options.prompt,
      tier: options.tier,
      mesh_mode: options.meshMode,
      geometry_file_format: options.format,
      quality_override: options.quality,
    });
    const images = await Promise.all(
      paths.map(async (path) => {
        const mime = mimeTypes[extname(path).toLowerCase()];
        if (!mime) throw new Error(`Unsupported image file extension: ${path}`);
        if (!(await stat(path)).isFile())
          throw new Error(`Image is not a regular file: ${path}`);
        const body = await readFile(path);
        if (!body.length) throw new Error(`Image is empty: ${path}`);
        return {
          body,
          file: {
            filename: basename(path),
            mime_type: mime,
            size_bytes: body.length,
          },
        };
      }),
    );
    // Validate generation options before creating uploads. IDs are assigned below.
    validateGenerate(context, {
      ...input,
      ...(images.length
        ? { reference_upload_ids: images.map(() => randomUUID()) }
        : {}),
    });
    if (images.length) {
      const { uploads } = await rodinCreateUploads(context, {
        files: images.map((image) => image.file),
      });
      if (!Array.isArray(uploads) || uploads.length !== images.length)
        throw new Error(
          'Server returned an unexpected number of image uploads',
        );
      // Validate all destinations before sending any image bytes.
      for (const upload of uploads) {
        const url = new URL(upload.upload_url);
        if (url.protocol !== 'https:')
          throw new Error('Image upload URL must use HTTPS');
        if (
          upload.method !== 'PUT' ||
          typeof upload.upload_id !== 'string' ||
          !upload.headers ||
          typeof upload.headers['Content-Type'] !== 'string'
        )
          throw new Error('Server returned an invalid image upload');
      }
      validateGenerate(context, {
        ...input,
        reference_upload_ids: uploads.map((u) => u.upload_id),
      });
      for (const [index, upload] of uploads.entries()) {
        // Presigned URL authentication only; never forward MCP credentials.
        const response = await fetch(upload.upload_url, {
          method: 'PUT',
          headers: upload.headers,
          body: images[index].body,
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        });
        await response.body?.cancel();
        if (!response.ok)
          throw new Error(
            `Image ${index + 1} upload failed (HTTP ${response.status}); generation was not started`,
          );
      }
      input.reference_upload_ids = uploads.map((upload) => upload.upload_id);
    }
    return rodinGenerate(context, input);
  }, context);
}

export async function status(generationId: string, context?: ToolContext) {
  return withToolContext(
    async (context) => rodinGetStatus(context, { generation_id: generationId }),
    context,
  );
}

export async function result(generationId: string, context?: ToolContext) {
  return withToolContext(
    async (context) => rodinGetResult(context, { generation_id: generationId }),
    context,
  );
}

export interface BangOptions {
  instruction?: string;
  strength?: number;
  format?: string;
}

export async function bang(
  generationId: string,
  options: BangOptions = {},
  context?: ToolContext,
) {
  return withToolContext(
    async (context) =>
      rodinGenerateBang(context, {
        asset_id: generationId,
        ...omitUndefined({
          instruction: options.instruction,
          strength: options.strength,
          geometry_file_format: options.format,
        }),
      }),
    context,
  );
}
