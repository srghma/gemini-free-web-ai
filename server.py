#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "rich>=13.7.0",
#     "readchar>=4.0.5",
#     "pygments>=2.17.0",
# ]
# ///
import sys
from pathlib import Path

# Add src to python path for modular import
sys.path.insert(0, str(Path(__file__).parent / "src"))

from gemini_bridge.server import main_cli

if __name__ == "__main__":
    main_cli()
