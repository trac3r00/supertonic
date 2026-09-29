"""Fixed local child executable used only to exercise harness receipts."""

from __future__ import annotations

import sys
import time
from typing import Final

EXPECTED_ARGUMENT_COUNT: Final = 2
MODE: Final = sys.argv[1] if len(sys.argv) == EXPECTED_ARGUMENT_COUNT else ""

match MODE:
    case "success":
        _ = sys.stdout.write("fixture success SYNTHETIC_SECRET_DO_NOT_LOG\n")
    case "failure":
        _ = sys.stdout.write("fixture failed\n")
        raise SystemExit(23)
    case "timeout":
        time.sleep(1)
    case _:
        raise SystemExit(2)
