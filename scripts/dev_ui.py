"""Launch the Python debugging UI with secrets supplied by op run."""

import os
import subprocess
import sys

from stage_worker import ROOT, command
from worker import serve


def use_docker():
    if os.environ.get("DEV_UI_IN_CONTAINER") == "1":
        return False
    flag = os.environ.get("DEV_UI_DOCKER")
    if flag == "1":
        return True
    if flag == "0":
        return False
    return os.name == "nt"


def run_docker():
    try:
        argv = command(
            "docker",
            "compose",
            "-f",
            str(ROOT / "dev" / "compose.yaml"),
            "up",
            "--build",
            "--abort-on-container-exit",
        )
    except FileNotFoundError:
        raise SystemExit(
            "Docker is required to run the debugging UI on Windows. Install Docker Desktop and retry."
        )
    return subprocess.run(argv, cwd=ROOT, env=os.environ).returncode


if __name__ == "__main__":
    token = os.environ.get("CF_AIG_TOKEN", "")
    if not token or token.startswith("op://"):
        raise SystemExit("Run pnpm run dev:ui so op run supplies CF_AIG_TOKEN.")
    extra = list(sys.argv[1:])
    if os.environ.get("DEV_UI_IN_CONTAINER") == "1":
        raise SystemExit(serve(dev_ui=True, extra=extra))
    if use_docker():
        raise SystemExit(run_docker())
    raise SystemExit(serve(dev_ui=True, extra=extra))
