"""Static checks and verification that bundled config matches its source."""

import ast
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    resources = ROOT / "src/ragbot/ai_config"
    expected = {p.name: p.read_text() for p in resources.iterdir() if p.suffix in {".json", ".md"}}
    module = ast.parse((ROOT / "src/ragbot/_bundled.py").read_text())
    actual = ast.literal_eval(module.body[0].value)
    if actual != expected:
        raise SystemExit("Bundled AI config is stale; run pnpm run build.")
    paths = ["src/ragbot", "src/entry.py", "dev", "scripts", "tests"]
    for command in [["ruff", "check", *paths], ["ruff", "format", "--check", *paths], ["mypy"]]:
        subprocess.run([sys.executable, "-m", *command], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
