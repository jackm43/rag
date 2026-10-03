"""Operator-only inputs for initializing D1; never imported by the Worker."""

from pathlib import Path


def load_resources():
    directory = Path(__file__).resolve().parents[1] / "config/ai"
    return {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(directory.iterdir())
        if path.suffix in (".json", ".md")
    }
