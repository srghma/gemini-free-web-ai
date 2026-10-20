import re
from dataclasses import dataclass
from .models import ChatTurn

@dataclass(frozen=True)
class ParsedCommand:
    lang: str          # "python", "bash", "bun", "cd", "write_next"
    timeout: str       # "60s", "2m", etc.
    code: str          # code for execution/write, or target dir for cd
    raw_trigger: str   # "EXECUTE_NEXT_PYTHON", "CD", "WRITE_NEXT"
    path: str = ""     # file path for write_next
    overwrite: bool = False

CD_REGEX = re.compile(
    r"CD\(\s*['\"]?([^'\"\r\n)]+?)['\"]?\s*\)",
    re.IGNORECASE,
)

WRITE_REGEX = re.compile(
    r"WRITE_NEXT\(\s*['\"]?([^'\"\r\n,)]+?)['\"]?(?:\s*,\s*overwrite=(true|false))?\s*\)\s*\r?\n```(?:[a-zA-Z0-9_-]+)?\s*\r?\n([\s\S]*?)\r?\n```",
    re.IGNORECASE,
)

EXEC_TRIGGER_REGEX = re.compile(
    r"(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)(?:\(timeout=([0-9]+(?:\.[0-9]+)?[smhd]?)\))?",
    re.IGNORECASE,
)

EXEC_FENCED_REGEX = re.compile(
    r"(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)(?:\(timeout=([0-9]+(?:\.[0-9]+)?[smhd]?)\))?\s*\r?\n```(?:[a-zA-Z0-9_-]+)?\s*\r?\n([\s\S]*?)\r?\n```",
    re.IGNORECASE,
)

def clean_extracted_code(code: str) -> str:
    cleaned = re.sub(r"^```[a-zA-Z0-9_-]*\r?\n", "", code, flags=re.IGNORECASE)
    cleaned = re.sub(r"\r?\n```$", "", cleaned)
    return cleaned.strip()

def extract_commands_from_text(text: str) -> list[ParsedCommand]:
    if not text:
        return []

    cd_cmds = [
        (m.start(), ParsedCommand(lang="cd", timeout="5s", code=m.group(1).strip(), raw_trigger="CD"))
        for m in CD_REGEX.finditer(text)
        if m.group(1).strip()
    ]

    write_cmds = [
        (
            m.start(),
            ParsedCommand(
                lang="write_next",
                timeout="10s",
                code=m.group(3).strip(),
                raw_trigger="WRITE_NEXT",
                path=m.group(1).strip(),
                overwrite=(m.group(2) or "").lower() == "true",
            ),
        )
        for m in WRITE_REGEX.finditer(text)
        if m.group(1).strip()
    ]

    exec_cmds = [
        (
            m.start(),
            ParsedCommand(
                lang=m.group(1).upper().lower().replace("execute_next_", ""),
                timeout=m.group(2) or "60s",
                code=m.group(3).strip(),
                raw_trigger=m.group(1).upper(),
            ),
        )
        for m in EXEC_FENCED_REGEX.finditer(text)
        if m.group(3).strip()
    ]

    all_cmds = cd_cmds + write_cmds + exec_cmds
    all_cmds.sort(key=lambda item: item[0])
    return [cmd for _, cmd in all_cmds]

def extract_commands_from_turn(turn: ChatTurn) -> list[ParsedCommand]:
    cmds = extract_commands_from_text(turn.chat_content)
    if cmds:
        return cmds

    triggers = list(EXEC_TRIGGER_REGEX.finditer(turn.chat_content))
    if triggers and turn.code_blocks:
        paired: list[ParsedCommand] = []
        for i, match in enumerate(triggers):
            trigger = match.group(1).upper()
            timeout = match.group(2) or "60s"
            lang = trigger.lower().replace("execute_next_", "")
            if i < len(turn.code_blocks):
                code = clean_extracted_code(turn.code_blocks[i].code)
                if code:
                    paired.append(ParsedCommand(lang=lang, timeout=timeout, code=code, raw_trigger=trigger))
        if paired:
            return paired

    synthesized = turn.chat_content
    for cb in turn.code_blocks:
        synthesized += f"\n```{cb.language}\n{cb.code}\n```\n"
    return extract_commands_from_text(synthesized)
