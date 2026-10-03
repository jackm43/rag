"""Static checks for the Worker, local tooling, and tests."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    paths = ["src/ragbot", "src/entry.py", "dev", "scripts", "tests"]
    for command in [["ruff", "check", *paths], ["ruff", "format", "--check", *paths], ["mypy"]]:
        subprocess.run([sys.executable, "-m", *command], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
