from types import SimpleNamespace

import pytest

from ragbot.discord import MEDIA_MAX_BYTES, MediaTooLargeError, download_media, is_message


class Chunk(bytes):
    @property
    def byteLength(self):
        return len(self)

    def to_py(self):
        return self


class Reader:
    def __init__(self, chunks):
        self.chunks = iter(chunks)
        self.cancelled = self.released = False

    async def read(self):
        value = next(self.chunks, None)
        return SimpleNamespace(
            done=value is None, value=Chunk(value) if value is not None else None
        )

    async def cancel(self):
        self.cancelled = True

    def releaseLock(self):
        self.released = True


async def test_media_stream_limit_cancels_before_buffering_oversize_chunk():
    reader = Reader([b"a" * MEDIA_MAX_BYTES, b"b"])
    body = SimpleNamespace(getReader=lambda: reader)

    async def transport(url, **kwargs):
        assert kwargs["timeout_ms"] == 30000
        assert "headers" not in kwargs
        return SimpleNamespace(
            ok=True, headers={"content-length": "1"}, js_response=SimpleNamespace(body=body)
        )

    with pytest.raises(MediaTooLargeError):
        await download_media("https://provider.test/media", transport=transport)
    assert reader.cancelled and reader.released


async def test_media_download_content_type_and_bytes():
    reader = Reader([b"abc", b"def"])

    async def transport(url, **kwargs):
        return SimpleNamespace(
            ok=True,
            headers={"content-type": "image/png"},
            js_response=SimpleNamespace(body=SimpleNamespace(getReader=lambda: reader)),
        )

    assert await download_media("https://provider.test/media", transport=transport) == (
        b"abcdef",
        "image/png",
    )
    assert reader.released


@pytest.mark.parametrize(
    "patch",
    [
        {"member": []},
        {"author": {"id": "id", "username": "u", "bot": "yes"}},
        {"attachments": [{"id": "id", "filename": "file", "url": 1}]},
        {"mentions": [None]},
        {"mention_roles": [1]},
        {"message_reference": None},
    ],
)
def test_invalid_message_shapes(patch):
    assert not is_message({"id": "message", "channel_id": "channel", **patch})
