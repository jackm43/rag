export async function* readNdjsonStream<T>(response: Response): AsyncGenerator<T> {
  if (!response.ok || !response.body) {
    throw new Error(await response.text());
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            yield JSON.parse(trimmed) as T;
          }
        }
      }
      if (done) {
        break;
      }
    }
    if (buffer.trim()) {
      yield JSON.parse(buffer.trim()) as T;
    }
  } finally {
    reader.releaseLock();
  }
}

export function ndjsonResponse<T>(
  source: AsyncIterable<T>,
  headers: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of source) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
        controller.close();
      } catch (error) {
        controller.enqueue(encoder.encode(`${JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })}\n`));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      ...headers,
    },
  });
}
