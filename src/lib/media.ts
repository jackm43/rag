// Bounded media reads: bytes, streams, base64, data URIs and HTTPS downloads, capped at 25 MiB.
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

export class MediaTooLargeError extends Error {
  name = "MediaTooLargeError";
}

type Source = ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string;

/** Read media into memory. Downloads send no credentials, time out, and are capped while streaming. */
export async function readMedia(source: Source, type = "application/octet-stream") {
  let data: Uint8Array;
  if (source instanceof ReadableStream) data = await readCapped(source);
  else if (source instanceof ArrayBuffer) data = new Uint8Array(source);
  else if (ArrayBuffer.isView(source)) data = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  else if (/^https:\/\//i.test(source)) {
    const response = await download(source);
    type = response.headers.get("content-type") || type;
    data = await readCapped(response.body);
  } else {
    let value = source;
    if (/^data:/i.test(value)) {
      const comma = value.indexOf(",");
      if (comma < 0 || !/;base64$/i.test(value.slice(0, comma))) throw new Error("invalid data URI");
      type = value.slice(5, comma - 7);
      value = value.slice(comma + 1);
      if (!type || !value) throw new Error("invalid data URI");
    }
    if (value.length > Math.floor((MEDIA_MAX_BYTES + 2) / 3) * 4) throw new MediaTooLargeError("media exceeds 25 MiB");
    data = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }
  if (data.byteLength > MEDIA_MAX_BYTES) throw new MediaTooLargeError("media exceeds 25 MiB");
  return { type, data };
}

async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`media download failed (${response.status})`);
  if (Number(response.headers.get("content-length")) > MEDIA_MAX_BYTES) {
    await response.body?.cancel();
    throw new MediaTooLargeError("media response exceeds 25 MiB");
  }
  return response;
}

async function readCapped(body: ReadableStream<Uint8Array> | null) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body ?? []) {
    size += chunk.byteLength;
    if (size > MEDIA_MAX_BYTES) throw new MediaTooLargeError("media response exceeds 25 MiB");
    chunks.push(chunk);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
