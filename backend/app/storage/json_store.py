"""Small JSON persistence primitives shared by the application record services.

The prototype persists documents, invoices and audit events as JSON files in a
single data directory. This module centralises the read/atomic-write behaviour
so every record collection is written the same way:

* writes go to a temporary file in the same directory, are fsynced, and replace
  the target atomically;
* writes within one process are serialised by a lock;
* reads of a missing file return a caller-provided default.

Multi-process writers are not supported by this adapter (unchanged from the
existing prototype behaviour); a single Uvicorn worker owns the data directory.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

_WRITE_LOCK = threading.RLock()


def read_json(path: Path, default: Any) -> Any:
    """Load JSON from `path`, returning `default` when the file is missing."""
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as source:
        return json.load(source)


def write_json_atomic(path: Path, payload: Any) -> None:
    """Write `payload` to `path` through an fsynced temporary file + replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: str | None = None
    with _WRITE_LOCK:
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=path.parent,
                prefix=f".{path.stem}-",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_path = temporary_file.name
                json.dump(payload, temporary_file, ensure_ascii=False, indent=2)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            Path(temporary_path).replace(path)
        finally:
            if temporary_path and Path(temporary_path).exists():
                Path(temporary_path).unlink()
