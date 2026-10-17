import asyncio
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class CodeBlock:
    language: str
    code: str

@dataclass
class PreferenceOption:
    index: int
    side: str
    text: str

@dataclass
class PreferenceVote:
    question: str
    options: list[PreferenceOption] = field(default_factory=list)
    has_submit_button: bool = True
    is_submit_disabled: bool = False

@dataclass
class ChatTurn:
    id: str
    type: str  # user, ai_thinking, ai_chat, ai_both
    status: str
    user_content: str = ""
    thinking_content: str = ""
    chat_content: str = ""
    code_blocks: list[CodeBlock] = field(default_factory=list)

@dataclass
class TabSession:
    tab_id: str
    title: str = "Chat"
    is_printing: bool = False
    button_label: str = "Run"
    prompt_text: str = ""
    preference_vote: PreferenceVote | None = None
    turns: list[ChatTurn] = field(default_factory=list)
    last_seen: datetime = field(default_factory=datetime.now)
    scroll_offset: int = 0
    follow_bottom: bool = True
    handled_turn_ids: set[str] = field(default_factory=set)
    handled_vote_keys: set[str] = field(default_factory=set)

    def merge_turns(self, raw_turns: list[dict]):
        if not raw_turns:
            return

        turn_order: list[str] = [t.id for t in self.turns]
        turns_map: dict[str, ChatTurn] = {t.id: t for t in self.turns}

        for rt in raw_turns:
            tid = rt.get("id") or ""
            if not tid:
                continue

            raw_cbs = rt.get("codeBlocks", [])
            cbs: list[CodeBlock] = []
            for cb in raw_cbs:
                if isinstance(cb, dict):
                    cbs.append(CodeBlock(language=cb.get("language") or cb.get("lang") or "bash", code=cb.get("code", "")))
                elif isinstance(cb, str):
                    cbs.append(CodeBlock(language="bash", code=cb))

            new_user = (rt.get("userContent") or "").strip()
            new_thinking = (rt.get("thinkingContent") or "").strip()
            new_chat = (rt.get("chatContent") or "").strip()
            new_type = rt.get("type", "ai_chat")
            new_status = rt.get("status", "completed")

            existing = turns_map.get(tid)

            user_content = new_user or (existing.user_content if existing else "")
            thinking_content = new_thinking or (existing.thinking_content if existing else "")
            chat_content = new_chat or (existing.chat_content if existing else "")
            code_blocks = cbs if cbs else (existing.code_blocks if existing else [])

            if not user_content and not thinking_content and not chat_content and not code_blocks:
                continue

            turn = ChatTurn(
                id=tid,
                type=new_type,
                status=new_status,
                user_content=user_content,
                thinking_content=thinking_content,
                chat_content=chat_content,
                code_blocks=code_blocks,
            )
            turns_map[tid] = turn
            if tid not in turn_order:
                turn_order.append(tid)

        self.turns = [turns_map[tid] for tid in turn_order if tid in turns_map]

class ServerState:
    def __init__(self):
        self.tabs: dict[str, TabSession] = {}
        self.selected_tab_idx: int = 0
        self.user_manually_selected = False
        self.logs: deque[str] = deque(maxlen=200)
        self.tasks_completed = 0
        self.tasks_failed = 0
        self.current_executing_task: dict | None = None
        self.stop_requested = False

    @property
    def tab_list(self) -> list[TabSession]:
        return list(self.tabs.values())

    def get_selected_tab(self) -> TabSession | None:
        tabs = self.tab_list
        if not tabs:
            return None
        self.selected_tab_idx = max(0, min(self.selected_tab_idx, len(tabs) - 1))
        return tabs[self.selected_tab_idx]

    def add_log(self, msg: str):
        t = datetime.now().strftime("%H:%M:%S")
        self.logs.append(f"[dim]{t}[/dim] {msg}")

state = ServerState()
render_event = asyncio.Event()
