"""Probe stock discord.py inside workerd without live Discord credentials."""

import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="ragbot-discordpy-") as directory:
        destination = Path(directory)
        shutil.copytree(ROOT / "experiments/discord_py", destination, dirs_exist_ok=True)
        (destination / "wrangler.jsonc").write_text(
            json.dumps(
                dict(
                    name="discordpy-workers-probe",
                    main="entry.py",
                    compatibility_date="2026-09-26",
                    compatibility_flags=["python_workers"],
                    workers_dev=False,
                )
            )
        )
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = dict(
            os.environ, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV="false", WRANGLER_SEND_METRICS="false"
        )
        with (destination / "runtime.log").open("w+") as log:
            process = subprocess.Popen(
                ["uv", "run", "--project", str(ROOT), "pywrangler", "dev", "--port", str(port)],
                cwd=destination,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            try:
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("Compatibility Worker failed to start")
                    try:
                        with urllib.request.urlopen(
                            f"http://127.0.0.1:{port}/peer", timeout=1
                        ) as r:
                            if r.status == 200:
                                break
                    except OSError, TimeoutError:
                        pass
                    time.sleep(0.25)
                else:
                    raise RuntimeError("Compatibility Worker startup timed out")
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=30) as response:
                    result = json.load(response)
                print(json.dumps(result, indent=2))
                # Errors in individual capabilities are probe findings, not runner failures.
                assert result["discord"] == "2.7.1"
                assert result["aiohttp"] == "3.13.5"
                assert all(name in result for name in ("http", "websocket", "heartbeat", "client"))
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-12000:])
                raise
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()


if __name__ == "__main__":
    main()
