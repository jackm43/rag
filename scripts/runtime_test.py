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
from stage_worker import ROOT, stage


def request(base, path, *, method="GET", body=None, headers=None):
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def main():
    with tempfile.TemporaryDirectory(prefix="ragbot-runtime-") as directory:
        destination = stage(Path(directory), runtime_test=True)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = dict(
            os.environ, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV="false", WRANGLER_SEND_METRICS="false"
        )
        with (destination / "runtime.log").open("w+") as logs:
            subprocess.run(
                [
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
                ],
                cwd=ROOT,
                env=env,
                check=True,
                stdout=logs,
                stderr=subprocess.STDOUT,
            )
            # Use the project's locked tooling rather than downloading another environment.
            process = subprocess.Popen(
                ["uv", "run", "--project", str(ROOT), "pywrangler", "dev", "--port", str(port)],
                cwd=destination,
                env=env,
                stdout=logs,
                stderr=subprocess.STDOUT,
                start_new_session=True,
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
                assert request(
                    base, "/interactions", method="POST", body=b"{}", headers=signed(body)
                ) == (401, b"")
                assert request(
                    base,
                    "/interactions",
                    method="POST",
                    body=body,
                    headers=signed(body, str(int(time.time()) - 301)),
                ) == (401, b"")
                assert request(
                    base, "/interactions", method="POST", body=b"[]", headers=signed(b"[]")
                ) == (400, b"")
                assert request(base, "/gateway/health") == (401, b"")
                assert request(
                    base, "/gateway/health", headers={"authorization": "Bearer wrong"}
                ) == (403, b"")
                headers = {"authorization": "Bearer test-control"}
                status, body = request(base, "/gateway/health", headers=headers)
                assert status == 200 and json.loads(body)["connected"] is False
                assert (
                    request(base, "/gateway/stop", method="POST", body=b"", headers=headers)[0]
                    == 200
                )
                status, body = request(base, "/test/scenario", method="POST", body=b"{}")
                if status != 200:
                    raise AssertionError(body.decode()[:5000])
                result = json.loads(body)
                assert result["totals"][0]["rag_count"] == 1
                assert len(result["threads"]) == 1
                assert result["interactions"][0]["status"] == "ok"
                assert result["interactions"][0]["response_text"] == "hello <https://example.com>"
                assert result["spend"][0]["total_tokens"] == 15
                assert result["multipart"] is True
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
                assert "borrowed proxy was automatically destroyed" not in logs.read()
                print(
                    "Python Workers runtime: signatures, bare denials, Durable Object controls, D1, /rag, /ask, spend, multipart and gateway WebSocket passed."
                )
            except Exception:
                logs.flush()
                logs.seek(0)
                print(logs.read()[-12000:])
                raise
            finally:
                import signal

                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


if __name__ == "__main__":
    main()
