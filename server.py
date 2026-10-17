#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "rich>=13.7.0",
#     "readchar>=4.0.5",
#     "pygments>=2.17.0",
# ]
# ///
import asyncio
import base64
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import time

import readchar
from readchar import key as K
from rich.console import Console, Group
from rich.layout import Layout
from rich.live import Live
from rich.markup import escape
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from executor import execute_task, parse_timeout

HOST = "127.0.0.1"
PORT = 8765
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
LOCK_FILE_PATH = Path("/tmp/gemini_bridge_daemon.lock")
LOG_FILE_PATH = Path.home() / "projects" / "gemini-free-web-ai" / "bridge_execution.log"

console = Console()

try:
    from pygments import highlight
    from pygments.formatters import Terminal256Formatter
    from pygments.lexers import BashLexer, PythonLexer, TypeScriptLexer
    HAS_PYGMENTS = True
except ImportError:
    HAS_PYGMENTS = False

def highlight_code(code: str, lang: str) -> str:
    if not HAS_PYGMENTS:
        return code
    lexer_map = {"python": PythonLexer(), "bash": BashLexer(), "bun": TypeScriptLexer()}
    lexer = lexer_map.get(lang.lower(), BashLexer())
    return highlight(code, lexer, Terminal256Formatter(style="monokai")).rstrip()

# --- State Definitions ---

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

# --- Lockfile & File Logging ---

def acquire_singleton_lock():
    lock_fd = os.open(LOCK_FILE_PATH, os.O_CREAT | os.O_RDWR, 0o666)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.ftruncate(lock_fd, 0)
        os.write(lock_fd, f"{os.getpid()}\n".encode())
        return lock_fd
    except BlockingIOError:
        console.print(f"[bold red]❌ Another instance is already running! (Lock: {LOCK_FILE_PATH})[/bold red]")
        sys.exit(1)

def log_to_file(entry: str):
    try:
        LOG_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {entry}\n")
    except Exception as e:
        state.add_log(f"[red]Log write error: {escape(str(e))}[/red]")

# --- WebSocket Frame Transport ---

def make_ws_frame(message: str, opcode: int = 0x81) -> bytes:
    data = message.encode("utf-8")
    length = len(data)
    frame = bytearray([opcode])
    if length <= 125:
        frame.append(length)
    elif length <= 65535:
        frame.append(126)
        frame.extend(struct.pack("!H", length))
    else:
        frame.append(127)
        frame.extend(struct.pack("!Q", length))
    frame.extend(data)
    return bytes(frame)

async def read_ws_frame(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> str | None:
    try:
        header = await reader.readexactly(2)
    except (asyncio.IncompleteReadError, ConnectionResetError):
        return None

    b1, b2 = header
    opcode = b1 & 0x0F
    if opcode == 0x8:
        return None
    if opcode == 0x9:
        writer.write(make_ws_frame("", opcode=0x8A))
        await writer.drain()
        return ""

    length = b2 & 0x7F
    if length == 126:
        ext = await reader.readexactly(2)
        length = struct.unpack("!H", ext)[0]
    elif length == 127:
        ext = await reader.readexactly(8)
        length = struct.unpack("!Q", ext)[0]

    mask = await reader.readexactly(4)
    payload = await reader.readexactly(length)
    return bytearray(b ^ mask[i % 4] for i, b in enumerate(payload)).decode("utf-8")

# --- Central Queue Worker (Serial Execution) ---

async def queue_worker():
    while not state.stop_requested:
        writer, task = await execution_queue.get()
        start_time = time.time()
        lang = task.get("type", "python").lower()
        code = task.get("code", "")
        timeout = parse_timeout(task.get("timeout"))
        tab_id = task.get("tabId", "unknown")

        state.current_executing_task = {"tab_id": tab_id, "lang": lang, "timeout": timeout, "start": start_time}
        state.add_log(f"🚀 [bold yellow]Executing {lang.upper()}[/bold yellow] for \\[{escape(tab_id)}\\] ({timeout:.0f}s timeout)")
        render_event.set()

        log_to_file(f"EXECUTE [{tab_id}] {lang.upper()} (timeout: {timeout}s)\n--- CODE ---\n{code}\n--- END CODE ---")

        try:
            writer.write(make_ws_frame(json.dumps({"status": "running", "type": lang, "timeout": f"{timeout}s"})))
            await writer.drain()
        except Exception:
            pass

        res = await execute_task(lang, code, timeout)
        elapsed = time.time() - start_time
        state.current_executing_task = None

        is_ok = not res.timed_out and res.exit_code == 0
        if is_ok:
            state.tasks_completed += 1
            status_tag = "[bold green]✓ SUCCESS[/bold green]"
        elif res.timed_out:
            state.tasks_failed += 1
            status_tag = "[bold yellow]⏱ TIMEOUT[/bold yellow]"
        else:
            state.tasks_failed += 1
            status_tag = f"[bold red]✗ EXIT {res.exit_code}[/bold red]"

        response = {
            "status": "timeout" if res.timed_out else ("error" if res.exit_code != 0 else "completed"),
            "type": lang,
            "output": res.output,
            "timedOut": res.timed_out,
            "exitCode": res.exit_code,
        }

        try:
            writer.write(make_ws_frame(json.dumps(response)))
            await writer.drain()
        except Exception as e:
            state.add_log(f"[red]Client disconnected before delivery: {escape(str(e))}[/red]")

        log_to_file(f"RESULT [{tab_id}] {response['status']} (Exit {res.exit_code}) in {elapsed:.2f}s\n--- OUTPUT ---\n{res.output}\n--- END OUTPUT ---\n")
        state.add_log(f"{status_tag} \\[{escape(tab_id)}\\] {lang.upper()} in {elapsed:.2f}s")
        render_event.set()
        execution_queue.task_done()

# --- Client Handler ---

async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    headers = b""
    while b"\r\n\r\n" not in headers:
        line = await reader.readline()
        if not line:
            return
        headers += line

    headers_str = headers.decode("utf-8", errors="ignore")
    ws_key = next((l.split(":", 1)[1].strip() for l in headers_str.split("\r\n") if l.lower().startswith("sec-websocket-key:")), None)
    if not ws_key:
        writer.close()
        return

    accept = base64.b64encode(hashlib.sha1((ws_key + WS_GUID).encode()).digest()).decode()
    handshake = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    writer.write(handshake.encode())
    await writer.drain()

    current_tab_id = f"tab_{id(writer) % 1000}"
    state.tabs[current_tab_id] = TabSession(tab_id=current_tab_id)
    state.add_log(f"🟢 [green]Chrome tab connected: \\[{escape(current_tab_id)}\\][/green]")
    render_event.set()

    try:
        while True:
            raw_msg = await read_ws_frame(reader, writer)
            if raw_msg is None:
                break
            if not raw_msg:
                continue

            data = json.loads(raw_msg)
            event = data.get("event")

            if event == "tab_connected":
                current_tab_id = data.get("tabId", current_tab_id)
                session = state.tabs.setdefault(current_tab_id, TabSession(tab_id=current_tab_id))
                session.title = data.get("title", "Chat")
                render_event.set()

            elif event == "tab_chat_update":
                tab_id = data.get("tabId", current_tab_id)
                session = state.tabs.setdefault(tab_id, TabSession(tab_id=tab_id))
                session.is_printing = data.get("isPrinting", False)
                session.button_label = data.get("buttonLabel", "Run")
                session.last_seen = datetime.now()

                raw_turns = data.get("turns", [])
                session.turns = [
                    ChatTurn(
                        id=t.get("id", ""),
                        type=t.get("type", "ai_chat"),
                        status=t.get("status", "completed"),
                        user_content=t.get("userContent", ""),
                        thinking_content=t.get("thinkingContent", ""),
                        chat_content=t.get("chatContent", ""),
                        code_blocks=t.get("codeBlocks", []),
                    )
                    for t in raw_turns
                ]

                # Auto-focus the tab that has active turns unless user manually switched
                if not state.user_manually_selected and session.turns:
                    cur_sel = state.get_selected_tab()
                    if not cur_sel or not cur_sel.turns:
                        try:
                            state.selected_tab_idx = list(state.tabs.keys()).index(tab_id)
                        except ValueError:
                            pass

                render_event.set()

            elif "command" in data:
                await execution_queue.put((writer, data))
                state.add_log(f"📥 Queued {data.get('type', '').upper()} from \\[{escape(data.get('tabId', current_tab_id))}\\]")
                render_event.set()

    except Exception:
        pass
    finally:
        state.tabs.pop(current_tab_id, None)
        state.add_log(f"⚪ [dim]Chrome tab closed: \\[{escape(current_tab_id)}\\][/dim]")
        render_event.set()
        writer.close()
        await writer.wait_closed()

# --- Rich TUI Layout & Renderer ---

def render_tui(height: int) -> Layout:
    layout = Layout()
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="tabs_bar", size=3),
        Layout(name="main_view", ratio=3),
        Layout(name="bottom_bar", size=8),
    )

    # 1. Header
    active_count = len(state.tabs)
    q_depth = execution_queue.qsize()
    header_content = (
        f"[bold magenta]⚡ GEMINI BRIDGE TUI MULTIPLEXER[/bold magenta] [dim]• ws://{HOST}:{PORT}[/dim] "
        f"│ Tabs: [cyan]{active_count}[/cyan] │ Queue: [yellow]{q_depth}[/yellow] "
        f"│ Completed: [green]{state.tasks_completed}[/green] │ Failed: [red]{state.tasks_failed}[/red]"
    )
    layout["header"].update(Panel(Text.from_markup(header_content), border_style="cyan"))

    # 2. Tabs Bar
    tab_list = state.tab_list
    tab_cells = []
    if not tab_list:
        tab_cells.append(Text("(No Chrome tabs connected - waiting on ws://127.0.0.1:8765)", style="dim italic"))
    else:
        for idx, tab in enumerate(tab_list):
            is_active = idx == state.selected_tab_idx
            status_ico = "✍" if tab.is_printing else "⏸"
            title = (tab.title[:14] + "…") if len(tab.title) > 14 else tab.title

            cell_text = f"[{idx + 1}] {tab.tab_id} ({title}) {status_ico}"
            if is_active:
                tab_cells.append(Text(f" ❯ {cell_text} ", style="bold white on #2d3748"))
            else:
                tab_cells.append(Text(f"   {cell_text} ", style="dim"))

    tabs_table = Table.grid(padding=(0, 1))
    tabs_table.add_row(*tab_cells)
    layout["tabs_bar"].update(Panel(tabs_table, title=f"[bold]Active Chrome Tabs[/bold] [dim](\\[1-9\\] / \\[h/l\\] Switch)[/dim]", border_style="dim"))

    # 3. Main Stream View for Selected Tab
    selected_tab = state.get_selected_tab()
    if not selected_tab or not selected_tab.turns:
        view_content = Text("\n\n  Waiting for chat activity in this tab...", style="dim italic")
    else:
        elements = []
        for turn in selected_tab.turns[-4:]:
            if turn.type == "user":
                elements.append(Text(f"👤 USER ({turn.id[-6:]})", style="bold cyan"))
                user_msg = (turn.user_content[:200] + "...") if len(turn.user_content) > 200 else turn.user_content
                elements.append(Panel(Text(user_msg or "(empty prompt)", style="white"), border_style="dim cyan"))

            if turn.thinking_content:
                status_txt = "streaming..." if turn.status == "streaming" else "settled"
                elements.append(Text(f"💭 THINKING ({status_txt})", style="italic magenta"))
                t_msg = (turn.thinking_content[:250] + "...") if len(turn.thinking_content) > 250 else turn.thinking_content
                elements.append(Panel(Text(t_msg, style="dim italic magenta"), border_style="dim magenta"))

            if turn.chat_content or turn.code_blocks:
                status_txt = "streaming..." if turn.status == "streaming" else "ready"
                elements.append(Text(f"🤖 AI RESPONSE ({status_txt})", style="bold green"))
                c_msg = (turn.chat_content[:300] + "...") if len(turn.chat_content) > 300 else turn.chat_content
                elements.append(Panel(Text(c_msg or "(rendering response...)", style="white"), border_style="green"))

                for code in turn.code_blocks:
                    elements.append(Text("⚡ EXECUTION PAYLOAD:", style="bold yellow"))
                    lines = code.splitlines()[:6]
                    code_preview = "\n".join(lines) + ("\n..." if len(code.splitlines()) > 6 else "")
                    elements.append(Panel(Text(code_preview, style="yellow"), border_style="yellow"))

        view_content = Group(*elements)

    curr_title = selected_tab.title if selected_tab else "No Tab"
    layout["main_view"].update(Panel(view_content, title=f"[bold cyan]Selected Tab: {escape(curr_title)}[/bold cyan]", border_style="magenta"))

    # 4. Bottom Activity & Logs
    log_lines = list(state.logs)[-5:]
    log_texts = [Text.from_markup(l) for l in log_lines] or [Text("Waiting for events...", style="dim")]

    cur_task = state.current_executing_task
    if cur_task:
        exec_banner = f"[bold yellow]▶ ACTIVE TASK: {cur_task['lang'].upper()} on \\[{escape(cur_task['tab_id'])}\\][/bold yellow] [dim]({time.time() - cur_task['start']:.1f}s)[/dim]"
    else:
        exec_banner = "[dim]Queue idle[/dim]"

    layout["bottom_bar"].update(
        Panel(
            Group(Text.from_markup(exec_banner), *log_texts),
            title=f"[bold]Central Queue & Logs[/bold] [dim](\\[q\\] Quit, \\[h/l\\] Tabs)[/dim]",
            border_style="dim",
        )
    )

    return layout

# --- Keyboard Navigation ---

async def key_listener():
    loop = asyncio.get_running_loop()
    while not state.stop_requested:
        k = await loop.run_in_executor(None, readchar.readkey)
        tabs_count = len(state.tabs)
        if k in (K.RIGHT, "l", "L", K.TAB, K.DOWN, "j"):
            if tabs_count:
                state.user_manually_selected = True
                state.selected_tab_idx = (state.selected_tab_idx + 1) % tabs_count
        elif k in (K.LEFT, "h", "H", K.BACKSPACE, K.UP, "k"):
            if tabs_count:
                state.user_manually_selected = True
                state.selected_tab_idx = (state.selected_tab_idx - 1) % tabs_count
        elif k.isdigit() and 1 <= int(k) <= tabs_count:
            state.user_manually_selected = True
            state.selected_tab_idx = int(k) - 1
        elif k in ("q", "Q", K.CTRL_C, K.CTRL_D):
            state.stop_requested = True
            render_event.set()
            break
        render_event.set()

# --- Main Daemon Lifecycle ---

async def main():
    worker_task = asyncio.create_task(queue_worker())
    key_task = asyncio.create_task(key_listener())
    server = await asyncio.start_server(handle_client, HOST, PORT)
    state.add_log(f"Server listening on ws://{HOST}:{PORT}")

    with Live(render_tui(console.size.height), console=console, screen=True, auto_refresh=False) as live:
        try:
            while not state.stop_requested:
                live.update(render_tui(console.size.height), refresh=True)
                try:
                    await asyncio.wait_for(render_event.wait(), timeout=0.2)
                    render_event.clear()
                except asyncio.TimeoutError:
                    pass
        finally:
            state.stop_requested = True
            worker_task.cancel()
            key_task.cancel()
            server.close()
            await server.wait_closed()

if __name__ == "__main__":
    lock_fd = acquire_singleton_lock()
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        try:
            os.close(lock_fd)
            if LOCK_FILE_PATH.exists():
                LOCK_FILE_PATH.unlink()
        except Exception:
            pass
