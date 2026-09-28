"""Build isolated local test/dev bundles without including them in production."""

import json
import os
import pprint
import shutil
import signal
import subprocess
from pathlib import Path

import pyjson5

ROOT = Path(__file__).resolve().parents[1]


def command(name, *args):
    if os.name == "nt":
        path = shutil.which(f"{name}.cmd") or shutil.which(f"{name}.exe") or shutil.which(name)
    else:
        path = shutil.which(name)
    if path is None:
        raise FileNotFoundError(name)
    if path.lower().endswith((".cmd", ".bat")):
        return ["cmd.exe", "/c", path, *args]
    return [path, *args]


def popen_kwargs():
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def stop_process(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            process.wait()
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def stage(destination: Path, *, dev: bool = False, runtime_test: bool = False):
    destination.mkdir(parents=True, exist_ok=True)
    source = destination / "src"
    source.mkdir(exist_ok=True)
    target_package = source / "ragbot"
    if target_package.exists():
        for stale in target_package.rglob("*"):
            original = ROOT / "src/ragbot" / stale.relative_to(target_package)
            if stale.is_file() and not original.exists():
                stale.unlink()
    shutil.copytree(
        ROOT / "src/ragbot",
        source / "ragbot",
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    shutil.copy(ROOT / "pyproject.toml", destination / "pyproject.toml")
    shutil.copy(ROOT / "uv.lock", destination / "uv.lock")
    config = pyjson5.loads((ROOT / ("wrangler.dev.jsonc" if dev else "wrangler.jsonc")).read_text())
    config.update(
        main="src/entry.py",
        compatibility_date="2026-09-26",
        compatibility_flags=["python_workers"],
        routes=[],
        workers_dev=False,
    )
    config.pop("rules", None)
    config.pop("build", None)
    config.pop("triggers", None)
    config.pop("services", None)
    for db in config.get("d1_databases", []):
        db["migrations_dir"] = str(ROOT / "migrations")
    if dev:
        for name in ("entry.py", "harness.py", "settings_api.py"):
            shutil.copy(ROOT / "dev" / name, source / name)
        production = pyjson5.loads((ROOT / "wrangler.jsonc").read_text())
        target = {
            "worker": production["name"],
            "account": production["vars"]["CF_ACCOUNT_ID"],
            "database": next(
                binding["database_id"]
                for binding in production["d1_databases"]
                if binding["binding"] == "DB"
            ),
            "namespace": next(
                binding["id"]
                for binding in production["kv_namespaces"]
                if binding["binding"] == "AI_CONFIG"
            ),
        }
        (source / "dev_target.py").write_text("TARGET = " + repr(target) + "\n")
        assets = {
            "/": ((ROOT / "dev/ui/index.html").read_text(), "text/html"),
            "/app.css": ((ROOT / "dev/ui/app.css").read_text(), "text/css"),
            "/app.client.js": ((ROOT / "dev/ui/app.client.js").read_text(), "text/javascript"),
        }
        (source / "dev_assets.py").write_text("ASSETS = " + pprint.pformat(assets) + "\n")
        config.pop("durable_objects", None)
        config.pop("migrations", None)
    else:
        shutil.copy(ROOT / "src/entry.py", source / "entry.py")
    if runtime_test:
        shutil.copy(source / "entry.py", source / "production.py")
        shutil.copy(ROOT / "tests/runtime_worker.py", source / "entry.py")
        config["name"] = "ragbot-python-runtime-test"
        config.pop("ai", None)
        config["services"] = [
            {"binding": "BUILDER", "service": config["name"], "entrypoint": "BuilderTest"}
        ]
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        public_key = (
            Ed25519PrivateKey.from_private_bytes(bytes([1]) * 32)
            .public_key()
            .public_bytes(Encoding.Raw, PublicFormat.Raw)
            .hex()
        )
        config["vars"] = {
            "DISCORD_PUBLIC_KEY": public_key,
            "DISCORD_APPLICATION_ID": "123456789012345678",
            "DISCORD_BOT_TOKEN": "test-bot",
            "GATEWAY_CONTROL_TOKEN": "test-control",
            "ALLOWED_GUILD_IDS": "457689460096630794",
            "CF_ACCOUNT_ID": "test-account",
            "CF_AIG_TOKEN": "test-ai",
        }
    (destination / "wrangler.jsonc").write_text(json.dumps(config, indent=2) + "\n")
    return destination
