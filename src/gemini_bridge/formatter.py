from .executor import ExecutionResult
from .truncator import save_and_truncate_output

SILENT_ON_SUCCESS = {"CD", "WRITE_NEXT", "WRITE"}

def format_execution_reply(lang: str, res: ExecutionResult, tab_id: str = "") -> str:
    l = (lang or "PYTHON").upper()
    output = save_and_truncate_output(lang, res.output or "", tab_id=tab_id)

    if res.timed_out:
        return f"PREVIOUS_{l}_TIMEOUT\n{output}".strip()
    if res.exit_code != 0:
        return f"PREVIOUS_{l}_ERROR (status={res.exit_code})\n{output}".strip()
    if l in SILENT_ON_SUCCESS:
        return ""
    return f"PREVIOUS_{l}_OUTPUT\n{output}".strip()

def group_replies(replies: list[str]) -> str:
    """Groups non-empty command execution outputs in sequential order separated by double newlines."""
    return "\n\n".join(r.strip() for r in replies if r and r.strip())
