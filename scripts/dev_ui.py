"""Launch the Python debugging UI with secrets supplied by op run."""

import os
import sys

from worker import serve

if __name__ == "__main__":
    token = os.environ.get("CF_AIG_TOKEN", "")
    if not token or token.startswith("op://"):
        raise SystemExit("Run pnpm run dev:ui so op run supplies CF_AIG_TOKEN.")
    raise SystemExit(serve(dev_ui=True, extra=sys.argv[1:]))
