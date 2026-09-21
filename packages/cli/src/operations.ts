import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { callContract, prepareCall } from './contracts/index.js';

import type {
  Payload,
  ToolClient,
  Contract,
  GenerateOptions,
} from './types.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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

function cliResult(data: Payload): Payload {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const result = { ...data };
  delete result.display_url;
  return result;
}

export function resultData(result: CallToolResult): Payload {
  if (result.isError)
    throw new Error(
      `Operation failed: ${
        result.content
          ?.filter((c) => c.type === 'text')
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('\n') || 'server returned an error'
      }`,
    );
  if (result.structuredContent) return cliResult(result.structuredContent);
  for (const item of result.content ?? []) {
    if (item.type === 'text') {
      try {
        return cliResult(JSON.parse(item.text));
      } catch {
        /* Try the next text block. */
      }
    }
  }
  throw new Error('Server returned no structured operation result');
}

export function createOperations(
  client: ToolClient,
  contract: Contract,
  remoteTools: Tool[],
) {
  const remote = (name: string) => remoteTools.find((t) => t.name === name);
  const call = async (name: string, input: Payload) =>
    resultData(await callContract(client, contract, name, input, remote(name)));
  return {
    call,
    async poll(
      generationId: string,
      timeoutSeconds = defaultPollTimeoutSeconds,
    ) {
      if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1)
        throw new Error(
          'Poll timeout must be a positive integer number of seconds',
        );
      let remainingSeconds = timeoutSeconds;
      let latest;
      do {
        const waitSeconds = Math.min(remainingSeconds, maximumWaitCallSeconds);
        latest = await call('rodin_wait', {
          generation_id: generationId,
          timeout_seconds: waitSeconds,
        });
        if (latest.timed_out !== true) return latest;
        remainingSeconds -= waitSeconds;
      } while (remainingSeconds > 0);
      return latest;
    },
    async generate(options: GenerateOptions) {
      const paths = options.image ?? [];
      if (paths.length > 5) throw new Error('Provide at most five images');
      if (!paths.length && !options.prompt?.trim())
        throw new Error('Provide --prompt or --image');
      const input = Object.fromEntries(
        [
          ['prompt', options.prompt],
          ['tier', options.tier],
          ['mesh_mode', options.meshMode],
          ['geometry_file_format', options.format],
          ['quality_override', options.quality],
        ].filter(([, value]) => value !== undefined),
      );
      const images = await Promise.all(
        paths.map(async (path) => {
          const mime = mimeTypes[extname(path).toLowerCase()];
          if (!mime)
            throw new Error(`Unsupported image file extension: ${path}`);
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
      prepareCall(
        contract,
        'rodin_generate',
        {
          ...input,
          ...(images.length
            ? { reference_upload_ids: images.map(() => randomUUID()) }
            : {}),
        },
        remote('rodin_generate'),
        () => {},
      );
      if (images.length) {
        const { uploads } = await call('rodin_create_uploads', {
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
        prepareCall(
          contract,
          'rodin_generate',
          { ...input, reference_upload_ids: uploads.map((u) => u.upload_id) },
          remote('rodin_generate'),
          () => {},
        );
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
      return call('rodin_generate', input);
    },
  };
}
