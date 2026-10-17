import re
from dataclasses import dataclass
from .models import ChatTurn

@dataclass(frozen=True)
class ParsedCommand:
    lang: str          # "python", "bash", "bun"
    timeout: str       # "60s", "2m", etc.
    code: str
    raw_trigger: str   # "EXECUTE_NEXT_PYTHON"

TRIGGER_REGEX = re.compile(
    r"(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)(?:\(timeout=([0-9]+(?:\.[0-9]+)?[smhd]?)\))?",
    re.IGNORECASE,
)

FENCED_CODE_REGEX = re.compile(
    r"(EXECUTE_NEXT_PYTHON|EXECUTE_NEXT_BASH|EXECUTE_NEXT_BUN)(?:\(timeout=([0-9]+(?:\.[0-9]+)?[smhd]?)\))?\s*[\r\n]+```(?:[a-zA-Z0-9_-]+)?\s*[\r\n]+([\s\S]*?)[\r\n]+```",
    re.IGNORECASE,
)

def clean_extracted_code(code: str) -> str:
    cleaned = re.sub(r"^```[a-zA-Z0-9_-]*\r?\n", "", code, flags=re.IGNORECASE)
    cleaned = re.sub(r"\r?\n```$", "", cleaned)
    return cleaned.strip()

def extract_commands_from_text(text: str) -> list[ParsedCommand]:
    commands: list[ParsedCommand] = []
    for match in FENCED_CODE_REGEX.finditer(text):
        trigger = match.group(1).upper()
        timeout = match.group(2) or "60s"
        code = match.group(3).strip()
        lang = trigger.lower().replace("execute_next_", "")
        if code:
            commands.append(ParsedCommand(lang=lang, timeout=timeout, code=code, raw_trigger=trigger))
    return commands

def extract_commands_from_turn(turn: ChatTurn) -> list[ParsedCommand]:
    """Extracts all commands from a model turn, handling both fenced text and pre-parsed code blocks."""
    cmds = extract_commands_from_text(turn.chat_content)
    if cmds:
        return cmds

    triggers = list(TRIGGER_REGEX.finditer(turn.chat_content))
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
