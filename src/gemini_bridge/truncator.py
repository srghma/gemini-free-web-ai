from datetime import datetime
import os
from pathlib import Path

MAX_PROMPT_OUTPUT_CHARS = 8000
TMP_LOGS_DIR = Path("/tmp/gemini_bridge_logs")
MAX_KEPT_LOGS = 20

def save_and_truncate_output(lang: str, output: str, tab_id: str = "") -> str:
    if not output:
        return ""

    TMP_LOGS_DIR.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    tab_suffix = f"_{tab_id}" if tab_id else ""
    log_file = TMP_LOGS_DIR / f"cmd_{ts}{tab_suffix}_{lang}.log"

    try:
        log_file.write_text(output, encoding="utf-8")
        _prune_old_logs(TMP_LOGS_DIR, MAX_KEPT_LOGS)
    except Exception:
        pass

    total_len = len(output)
    if total_len <= MAX_PROMPT_OUTPUT_CHARS:
        return output

    head_len = 3500
    mid_len = 1000
    tail_len = 3500

    head = output[:head_len]
    mid_start = max(head_len, (total_len // 2) - (mid_len // 2))
    mid = output[mid_start : mid_start + mid_len]
    tail = output[-tail_len:]

    truncated_msg = (
        f"{head}\n\n"
        f"--- [OUTPUT TRUNCATED: {total_len} chars total. Showing first {head_len}, "
        f"middle {mid_len}, and last {tail_len} chars. Full log saved to: {log_file}] ---\n\n"
        f"{mid}\n\n"
        f"--- [... middle omitted ...] ---\n\n"
        f"{tail}"
    )
    return truncated_msg

def _prune_old_logs(log_dir: Path, max_files: int):
    try:
        files = sorted(
            [f for f in log_dir.glob("cmd_*.log") if f.is_file()],
            key=lambda p: p.stat().st_mtime,
        )
        while len(files) > max_files:
            oldest = files.pop(0)
            try:
                oldest.unlink(missing_ok=True)
            except OSError:
                pass
    except Exception:
        pass
