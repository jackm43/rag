"""Run local Python Workers from an isolated bundle with live source updates."""

import os
import subprocess
import sys
import time

from stage_worker import ROOT, command, popen_kwargs, stage, stop_process

SECRETS = [
    "DISCORD_PUBLIC_KEY",
    "DISCORD_BOT_TOKEN",
    "GATEWAY_CONTROL_TOKEN",
    "CLOUDFLARE_API_TOKEN",
]


def watch_signature():
    paths = [
        p
        for folder in ("src/ragbot", "dev")
        for p in (ROOT / folder).rglob("*")
        if p.is_file()
        and p.suffix in (".py", ".json", ".md", ".html", ".css", ".js")
        and "__pycache__" not in p.parts
    ]
    paths.extend([ROOT / "src/entry.py", ROOT / "wrangler.jsonc", ROOT / "wrangler.dev.jsonc"])
    return tuple((str(p), p.stat().st_mtime_ns) for p in sorted(paths))


def serve(*, dev_ui=False, extra=()):
    import json

    destination = ROOT / ".wrangler" / ("python-dev" if dev_ui else "python-local")

    def prepare():
        stage(destination, dev=dev_ui)
        config_path = destination / "wrangler.jsonc"
        config = json.loads(config_path.read_text())
        if not dev_ui:
            config["secrets"] = {"required": SECRETS}
            # Use the same local D1 state as root wrangler migration commands.
            config["triggers"] = {"crons": ["*/15 * * * *"]}
        config_path.write_text(json.dumps(config, indent=2) + "\n")

    prepare()
    env = dict(
        os.environ,
        CLOUDFLARE_INCLUDE_PROCESS_ENV="true",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV="true",
    )
    if dev_ui:
        # Mounted Windows/Docker directories do not reliably emit file events.
        env.setdefault("CHOKIDAR_USEPOLLING", "true")
        env.setdefault("CHOKIDAR_INTERVAL", "500")
    state = ROOT / ".wrangler" / ("dev-state" if dev_ui else "state")
    if dev_ui:
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
                "--persist-to",
                str(state),
                "-c",
                str(destination / "wrangler.jsonc"),
            ),
            cwd=ROOT,
            env=env,
            check=True,
        )
        # Bootstrap only an empty local sandbox before starting the Worker.
        # This operator step never changes existing settings or the live database.
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/initialize_ai_settings.py"),
                "--local",
                "--persist-to",
                str(state),
            ],
            cwd=ROOT,
            env=env,
            check=True,
        )
    process = subprocess.Popen(
        command(
            "uv",
            "run",
            "--project",
            str(ROOT),
            "pywrangler",
            "dev",
            "--persist-to",
            str(state),
            *extra,
        ),
        cwd=destination,
        env=env,
        **popen_kwargs(),
    )
    try:
        signature = watch_signature()
        while process.poll() is None:
            time.sleep(0.5)
            current = watch_signature()
            if current != signature:
                prepare()
                signature = watch_signature()
        return process.returncode
    except KeyboardInterrupt:
        return 0
    finally:
        stop_process(process)


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] != "dev":
        raise SystemExit("Usage: worker.py dev [wrangler options]")
    raise SystemExit(serve(extra=sys.argv[2:]))
