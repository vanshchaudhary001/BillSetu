import sys
import os
from pathlib import Path

# Ensure backend directory is in python search path
root_dir = Path(__file__).resolve().parent.parent
backend_dir = root_dir / "backend"
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))
if str(root_dir) not in sys.path:
    sys.path.insert(0, str(root_dir))

# Ensure writable directories on Vercel serverless environment
if os.getenv("VERCEL"):
    tmp_data = Path("/tmp/billsetu")
    try:
        tmp_data.mkdir(parents=True, exist_ok=True)
        (tmp_data / "private-documents").mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"Warning: could not create /tmp directories: {e}", flush=True)

from app.main import app
