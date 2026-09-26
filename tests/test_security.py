import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from ragbot.security import authorize_control, verify_discord_signature


async def verify(key, signature, message):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    Ed25519PublicKey.from_public_bytes(key).verify(signature, message)
    return True


@pytest.mark.asyncio
async def test_signature_and_tampered_payload():
    private = Ed25519PrivateKey.generate()
    key = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
    body = b'{"type":1}'
    timestamp = "1700000000"
    signature = private.sign(timestamp.encode() + body).hex()
    assert await verify_discord_signature(
        key, signature, timestamp, body, now=1700000000, verify=verify
    )
    assert not await verify_discord_signature(
        key, signature, timestamp, b"{}", now=1700000000, verify=verify
    )
    assert not await verify_discord_signature(
        key, signature, timestamp, body, now=1700000301, verify=verify
    )
    assert not await verify_discord_signature(
        key, signature, timestamp, body, now=1699999699, verify=verify
    )
    assert not await verify_discord_signature(key, signature, "bad", body, verify=verify)
    assert not await verify_discord_signature("", signature, timestamp, body, verify=verify)


@pytest.mark.parametrize(
    "token,header,status",
    [
        (None, "Bearer x", 401),
        ("x", None, 401),
        ("x", "Basic x", 401),
        ("x", "Bearer ", 401),
        ("x", "Bearer y", 403),
        ("x", "bEaReR x", None),
        ("x", "Bearer é", 403),
    ],
)
def test_control(token, header, status):
    assert authorize_control(token, header) == status
