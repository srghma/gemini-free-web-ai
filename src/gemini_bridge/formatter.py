from .executor import ExecutionResult

def format_execution_reply(lang: str, res: ExecutionResult) -> str:
    l = (lang or "PYTHON").upper()
    output = res.output or ""

    if res.timed_out:
        return f"PREVIOUS_{l}_TIMEOUT\n{output}"
    if res.exit_code != 0:
        return f"PREVIOUS_{l}_ERROR (status={res.exit_code})\n{output}"
    return f"PREVIOUS_{l}_OUTPUT\n{output}"

def group_replies(replies: list[str]) -> str:
    """Groups all command execution outputs in sequential order separated by double newlines."""
    return "\n\n".join(r.strip() for r in replies if r and r.strip())
