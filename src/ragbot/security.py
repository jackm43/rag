"""Authentication at the two external HTTP edges."""

import hmac
import time


async def webcrypto_verify(key: bytes, signature: bytes, message: bytes) -> bool:
    from js import crypto
    from pyodide.ffi import to_js

    public_key = await crypto.subtle.importKey(
        "raw", to_js(key), "Ed25519", False, to_js(["verify"])
    )
    return bool(await crypto.subtle.verify("Ed25519", public_key, to_js(signature), to_js(message)))


async def verify_discord_signature(
    public_key: str,
    signature: str | None,
    timestamp: str | None,
    body: bytes,
) -> bool:
    if not public_key or not signature or not timestamp:
        return False
    try:
        if abs(time.time() - int(timestamp)) > 300:
            return False
        return await webcrypto_verify(
            bytes.fromhex(public_key), bytes.fromhex(signature), timestamp.encode() + body
        )
    except Exception:
        return False


def authorize_control(token: str | None, authorization: str | None) -> int | None:
    """Return a bare denial status, or None on success."""
    if not token or not authorization:
        return 401
    scheme, _, presented = authorization.partition(" ")
    if scheme.lower() != "bearer" or not presented:
        return 401
    if not hmac.compare_digest(presented.encode(), token.encode()):
        return 403
    return None
