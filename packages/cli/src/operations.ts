import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import {
  rodinCreateUploads,
  rodinGenerate,
  rodinGenerateBang,
  rodinGenerateAgentic,
  rodinGenerateRigging,
  rodinListAnimationPresets,
  validateOperation,
  rodinGetStatus,
  rodinGetResult,
  rodinWait,
  validateGenerate,
  withToolContext,
} from './mcp.js';
import { omitUndefined } from './utils.js';

import type { ToolContext } from './mcp.js';
import type { Payload, GenerateOptions } from './types.js';

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
      if (
        ['completed', 'failed', 'unknown'].includes(latest.status) ||
        latest.timed_out !== true
      )
        return latest;
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
      texture_delight: options.textureDelight,
      geometry_file_format: options.format,
      quality_override: options.quality,
    });
    await uploadFiles(
      paths,
      'image',
      input,
      'reference_upload_ids',
      (value) => validateGenerate(context, value),
      context,
    );
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

async function uploadFiles(
  paths: string[],
  kind: 'image' | 'animation',
  input: Payload,
  idField: string,
  validate: (value: Payload) => void,
  context: ToolContext,
) {
  const files = await Promise.all(
    paths.map(async (path) => {
      const mime =
        kind === 'animation'
          ? extname(path).toLowerCase() === '.fbx'
            ? 'application/octet-stream'
            : undefined
          : mimeTypes[extname(path).toLowerCase()];
      if (!mime) throw new Error(`Unsupported upload file extension: ${path}`);
      const metadata = await stat(path);
      if (!metadata.isFile())
        throw new Error(`File is not a regular file: ${path}`);
      if (metadata.size > (kind === 'animation' ? 25 : 20) * 1024 * 1024)
        throw new Error('Upload file exceeds size limit');
      const body = await readFile(path);
      if (body.length > (kind === 'animation' ? 25 : 20) * 1024 * 1024)
        throw new Error('Upload file exceeds size limit');
      if (!body.length) throw new Error(`File is empty: ${path}`);
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
  validate({
    ...input,
    ...(files.length ? { [idField]: files.map(() => randomUUID()) } : {}),
  });
  if (files.length) {
    const { uploads } = await rodinCreateUploads(context, {
      ...(kind === 'animation' ? { kind } : {}),
      files: files.map((image) => image.file),
    });
    if (!Array.isArray(uploads) || uploads.length !== files.length)
      throw new Error('Server returned an unexpected number of uploads');
    // Validate all destinations before sending any file bytes.
    for (const upload of uploads) {
      const url = new URL(upload.upload_url);
      if (url.protocol !== 'https:')
        throw new Error('Upload URL must use HTTPS');
      if (
        upload.method !== 'PUT' ||
        typeof upload.upload_id !== 'string' ||
        !upload.headers ||
        typeof upload.headers['Content-Type'] !== 'string'
      )
        throw new Error('Server returned an invalid upload');
    }
    validate({
      ...input,
      [idField]: uploads.map((u) => u.upload_id),
    });
    for (const [index, upload] of uploads.entries()) {
      // Presigned URL authentication only; never forward MCP credentials.
      const response = await fetch(upload.upload_url, {
        method: 'PUT',
        headers: upload.headers,
        body: files[index].body,
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(
          `File ${index + 1} upload failed (HTTP ${response.status}); generation was not started`,
        );
    }
    input[idField] = uploads.map((upload) => upload.upload_id);
  }
}

export interface AgenticOptions {
  image?: string[];
  prompt?: string;
  tier?: string;
  format?: string;
}

export async function agentic(options: AgenticOptions, context?: ToolContext) {
  return withToolContext(async (context) => {
    const paths = options.image ?? [];
    if (!paths.length || paths.length > 5)
      throw new Error('Provide one to five --image files');
    const input = omitUndefined({
      prompt: options.prompt,
      tier: options.tier,
      export_type: options.format,
    });
    await uploadFiles(
      paths,
      'image',
      input,
      'reference_upload_ids',
      (value) => validateOperation(context, 'rodin_generate_agentic', value),
      context,
    );
    return rodinGenerateAgentic(context, input);
  }, context);
}

export interface RiggingOptions {
  boneTemplate: string;
  skeletonDescription?: string;
  skinningMethod?: string;
  format?: string;
  animationPreset?: string[];
  animation?: string[];
}

export async function rigging(
  assetId: string,
  options: RiggingOptions,
  context?: ToolContext,
) {
  return withToolContext(async (context) => {
    const paths = options.animation ?? [];
    const presets = options.animationPreset ?? [];
    if (paths.length && presets.length)
      throw new Error('Use --animation or --animation-preset, not both');
    if (paths.length > 10 || presets.length > 10)
      throw new Error('Provide at most ten animations');
    if (new Set(presets).size !== presets.length)
      throw new Error('Animation presets must be distinct');
    if (
      options.boneTemplate === 'custom'
        ? !options.skeletonDescription?.trim()
        : options.skeletonDescription !== undefined
    )
      throw new Error(
        '--skeleton-description is required only for --bone-template custom',
      );
    const input = omitUndefined({
      asset_id: assetId,
      bone_template: options.boneTemplate,
      skeleton_description: options.skeletonDescription,
      skinning_method: options.skinningMethod,
      geometry_file_format: options.format,
      animation_preset: presets.length ? presets : undefined,
    });
    await uploadFiles(
      paths,
      'animation',
      input,
      'animation_upload_ids',
      (value) => validateOperation(context, 'rodin_generate_rigging', value),
      context,
    );
    return rodinGenerateRigging(context, input);
  }, context);
}

export async function animationPresets(
  category?: string,
  context?: ToolContext,
) {
  return withToolContext(
    async (context) =>
      rodinListAnimationPresets(context, omitUndefined({ category })),
    context,
  );
}
