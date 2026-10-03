"""Run production ingress and D1 scenarios in a real local Python Worker."""

import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from stage_worker import ROOT, command, popen_kwargs, stage, stop_process


def request(base, path, *, method="GET", body=None, headers=None):
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def main():
    temporary_root = ROOT / ".wrangler"
    temporary_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ragbot-runtime-", dir=temporary_root) as directory:
        destination = stage(Path(directory), runtime_test=True)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = dict(
            os.environ, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV="false", WRANGLER_SEND_METRICS="false"
        )
        with (destination / "runtime.log").open("w+", encoding="utf-8") as logs:
            subprocess.run(
                command(
                    "pnpm",
                    "exec",
                    "wrangler",
                    "d1",
                    "migrations",
                    "apply",
                    "ragbot",
                    "--local",
                    "-c",
                    str(destination / "wrangler.jsonc"),
                ),
                cwd=ROOT,
                env=env,
                check=True,
                stdout=logs,
                stderr=subprocess.STDOUT,
            )
            process = subprocess.Popen(
                command(
                    "uv", "run", "--project", str(ROOT), "pywrangler", "dev", "--port", str(port)
                ),
                cwd=destination,
                env=env,
                stdout=logs,
                stderr=subprocess.STDOUT,
                **popen_kwargs(),
            )
            base = f"http://127.0.0.1:{port}"
            try:
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("Python Worker failed to start")
                    try:
                        if request(base, "/")[0] == 404:
                            break
                    except OSError, TimeoutError:
                        pass
                    time.sleep(0.25)
                else:
                    raise RuntimeError("Python Worker startup timed out")
                assert request(base, "/interactions", method="POST", body=b"{}") == (401, b"")
                private_key = Ed25519PrivateKey.from_private_bytes(bytes([1]) * 32)

                def signed(body, timestamp=None):
                    timestamp = timestamp or str(int(time.time()))
                    return {
                        "x-signature-timestamp": timestamp,
                        "x-signature-ed25519": private_key.sign(timestamp.encode() + body).hex(),
                    }

                body = b'{"type":1}'
                assert request(
                    base, "/interactions", method="POST", body=body, headers=signed(body)
                ) == (200, b'{"type": 1}')
                invalid_headers = [
                    {},
                    signed(b"{}"),
                    *[signed(body, str(int(time.time()) + offset)) for offset in (-301, 310)],
                    {**signed(body), "x-signature-timestamp": "bad"},
                    {**signed(body), "x-signature-ed25519": "bad"},
                ]
                for headers in invalid_headers:
                    assert request(
                        base, "/interactions", method="POST", body=body, headers=headers
                    ) == (401, b"")
                for malformed in (b"[", b"[]", b"null", b'{"type":true}', b'{"type":3}'):
                    assert request(
                        base,
                        "/interactions",
                        method="POST",
                        body=malformed,
                        headers=signed(malformed),
                    ) == (400, b"")
                for path, method in (
                    ("/gateway/start", "POST"),
                    ("/gateway/stop", "POST"),
                    ("/gateway/health", "GET"),
                ):
                    for authorization, status in (
                        ("", 401),
                        ("Basic x", 401),
                        ("Bearer ", 401),
                        ("Bearer wrong", 403),
                    ):
                        assert request(
                            base, path, method=method, headers={"authorization": authorization}
                        ) == (status, b"")
                for path, method in (
                    ("/interactions", "GET"),
                    ("/gateway/start", "GET"),
                    ("/gateway/health", "POST"),
                    ("/missing", "GET"),
                ):
                    assert request(base, path, method=method) == (404, b"")
                headers = {"authorization": "bEaReR test-control"}
                status, body = request(base, "/gateway/health", headers=headers)
                assert status == 200 and json.loads(body)["connected"] is False
                assert request(base, "/gateway/stop", method="POST", headers=headers)[0] == 200
                # Invoke through workerd so the scheduled handler's FFI signature is exercised.
                status, body = request(base, "/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*")
                assert status == 200, (status, body)
                status, body = request(base, "/gateway/health", headers=headers)
                assert status == 200 and json.loads(body)["stopped"] is True
                # Exercise the real signed entrypoint and waitUntil dispatch, with stubbed egress.
                interaction = json.dumps(
                    {
                        "type": 2,
                        "application_id": "123456789012345678",
                        "token": "test-webhook",
                        "guild_id": "457689460096630794",
                        "member": {"user": {"id": "123456789012345679", "username": "tester"}},
                        "data": {
                            "name": "rag",
                            "options": [{"name": "user", "value": "123456789012345682"}],
                            "resolved": {"users": {"123456789012345682": {"username": "target"}}},
                        },
                    }
                ).encode()
                assert request(
                    base,
                    "/interactions",
                    method="POST",
                    body=interaction,
                    headers=signed(interaction),
                ) == (200, b'{"type": 5}')
                for path, method in (
                    ("/gateway/start", "POST"),
                    ("/gateway/stop", "POST"),
                    ("/gateway/health", "GET"),
                    ("/interactions", "POST"),
                ):
                    assert request(
                        base,
                        "/test/unconfigured" + path,
                        method=method,
                        body=body if method == "POST" else None,
                        headers={**signed(body), **headers},
                    ) == (401, b"")
                status, body = request(base, "/test/scenario", method="POST", body=b"{}")
                if status != 200:
                    raise AssertionError(body.decode()[:5000])
                result = json.loads(body)
                assert result["totals"][0]["rag_count"] == 1
                assert len(result["threads"]) == 1
                assert result["interactions"][0]["status"] == "ok"
                assert result["interactions"][0]["response_text"] == "hello <https://example.com>"
                assert result["spend"] == []
                assert result["multipart"] is True
                status, body = request(base, "/test/settings")
                assert status == 200 and json.loads(body) == {
                    "refreshed": True,
                    "requiresD1": True,
                }
                status, body = request(base, "/test/gateway")
                if status != 200:
                    raise AssertionError(body.decode()[:5000])
                gateway = json.loads(body)
                assert gateway["health"] == {
                    "connected": True,
                    "resumable": True,
                    "stopped": False,
                }, gateway
                assert gateway["processed"] == ["123456789012345699"], gateway
                assert gateway["sequence"] == 2, gateway
                assert gateway["heartbeat"] is True, gateway
                assert gateway["stopped"] == {"ok": False, "stopped": True}, gateway
                logs.flush()
                logs.seek(0)
                runtime_logs = logs.read()
                assert "borrowed proxy was automatically destroyed" not in runtime_logs
                assert "gateway_ensure_connected_failed" not in runtime_logs
                print(
                    "Python Workers runtime: signatures, bare denials, Durable Object controls, cron, D1, /rag, /ask, multipart, immediate D1 settings refresh and gateway WebSocket passed."
                )
            except Exception:
                logs.flush()
                logs.seek(0)
                print(logs.read()[-12000:])
                raise
            finally:
                stop_process(process)


if __name__ == "__main__":
    main()
