import asyncio
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class ChatTurn:
    id: str
    type: str  # user, ai_thinking, ai_chat, ai_both
    status: str
    user_content: str = ""
    thinking_content: str = ""
    chat_content: str = ""
    code_blocks: list[str] = field(default_factory=list)

@dataclass
class TabSession:
    tab_id: str
    title: str = "Chat"
    is_printing: bool = False
    button_label: str = "Run"
    prompt_text: str = ""
    variants: list[dict] = field(default_factory=list)
    turns: list[ChatTurn] = field(default_factory=list)
    last_seen: datetime = field(default_factory=datetime.now)

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
execution_queue: asyncio.Queue[tuple[asyncio.StreamWriter, dict]] = asyncio.Queue()
