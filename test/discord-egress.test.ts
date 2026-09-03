import { assert, describe, test } from "vitest";

import { downloadMedia, MediaTooLargeError, suppressUrlEmbeds } from "../src/lib/discord";

const withFetch = async (respond: () => Response, body: () => Promise<void>) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => respond();
  try {
    await body();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const chunkedStream = (chunkBytes: number, chunks: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < chunks; i += 1) {
        controller.enqueue(new Uint8Array(chunkBytes));
      }
      controller.close();
    },
  });

describe("downloadMedia", () => {
  test("returns the bytes and content type of a small response", async () => {
    await withFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
      async () => {
        const media = await downloadMedia("https://example.com/a.mp3");
        assert.equal(media.contentType, "audio/mpeg");
        assert.deepEqual([...new Uint8Array(media.data)], [1, 2, 3]);
      },
    );
  });

  test("rejects an over-cap declared content-length without reading the body", async () => {
    await withFetch(
      () => new Response(chunkedStream(1, 1), { headers: { "content-length": String(26 * 1024 * 1024) } }),
      async () => {
        await downloadMedia("https://example.com/big").then(
          () => assert.fail("expected MediaTooLargeError"),
          (error) => assert.instanceOf(error, MediaTooLargeError),
        );
      },
    );
  });

  test("enforces the cap while streaming when no content-length is declared", async () => {
    // 26 x 1 MiB chunks, no content-length header: the old check let this
    // buffer all 26 MiB; the streamed cap must abort past 25 MiB.
    await withFetch(
      () => new Response(chunkedStream(1024 * 1024, 26)),
      async () => {
        await downloadMedia("https://example.com/chunked").then(
          () => assert.fail("expected MediaTooLargeError"),
          (error) => assert.instanceOf(error, MediaTooLargeError),
        );
      },
    );
  });

  test("throws a plain error on a non-2xx status", async () => {
    await withFetch(
      () => new Response("nope", { status: 404 }),
      async () => {
        await downloadMedia("https://example.com/missing").then(
          () => assert.fail("expected an error"),
          (error) => {
            assert.notInstanceOf(error, MediaTooLargeError);
            assert.match(String(error), /404/);
          },
        );
      },
    );
  });
});

describe("suppressUrlEmbeds", () => {
  test("wraps bare URLs and leaves already-wrapped ones and code alone", () => {
    assert.equal(suppressUrlEmbeds("see https://a.com/x."), "see <https://a.com/x>.");
    assert.equal(suppressUrlEmbeds("see <https://a.com/x>"), "see <https://a.com/x>");
    assert.equal(suppressUrlEmbeds("`https://a.com` and ```\nhttps://b.com\n```"), "`https://a.com` and ```\nhttps://b.com\n```");
  });

  test("keeps a markdown link's closing paren outside the wrapped URL", () => {
    assert.equal(suppressUrlEmbeds("[docs](https://a.com/path)"), "[docs](<https://a.com/path>)");
    assert.equal(suppressUrlEmbeds("(see https://a.com/path)."), "(see <https://a.com/path>).");
  });

  test("keeps balanced parens that are part of the URL", () => {
    assert.equal(
      suppressUrlEmbeds("https://en.wikipedia.org/wiki/Rag_(disambiguation)"),
      "<https://en.wikipedia.org/wiki/Rag_(disambiguation)>",
    );
  });
});
