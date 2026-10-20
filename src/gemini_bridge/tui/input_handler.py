import asyncio
from contextlib import contextmanager
import json
import os
import select
import sys
import termios
import tty
from rich.markup import escape

from ..models import ServerState
from ..transport import make_ws_frame

def get_char_nonblocking(fd: int, timeout: float = 0.2) -> str | None:
    try:
        r, _, _ = select.select([fd], [], [], timeout)
        if r:
            return os.read(fd, 128).decode("utf-8", errors="ignore")
    except Exception:
        pass
    return None

@contextmanager
def terminal_raw_mode(fd: int):
    is_tty = os.isatty(fd)
    old_settings = None

    if is_tty:
        try:
            old_settings = termios.tcgetattr(fd)
            tty.setcbreak(fd)
            # Enable mouse reporting (SGR mode 1006 + tracking 1000/1002)
            sys.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h")
            sys.stdout.flush()
        except Exception:
            old_settings = None

    try:
        yield
    finally:
        if is_tty:
            try:
                # Disable mouse reporting
                sys.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l")
                sys.stdout.flush()
                if old_settings:
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
            except Exception:
                pass

async def key_listener(state: ServerState, render_event: asyncio.Event):
    from ..orchestrator import apply_user_variant_choice

    loop = asyncio.get_running_loop()
    fd = sys.stdin.fileno()

    with terminal_raw_mode(fd):
        while not state.stop_requested:
            ch = await loop.run_in_executor(None, get_char_nonblocking, fd, 0.2)
            if not ch:
                continue

            tabs_count = len(state.tabs)
            cur_tab = state.get_selected_tab()

            # Mouse wheel events
            wheel_up = ch.count("<64;")
            wheel_down = ch.count("<65;")
            if wheel_up > 0 and cur_tab:
                cur_tab.follow_bottom = False
                cur_tab.scroll_offset += 4 * wheel_up
                render_event.set()
                continue
            if wheel_down > 0 and cur_tab:
                cur_tab.scroll_offset = max(0, cur_tab.scroll_offset - 4 * wheel_down)
                if cur_tab.scroll_offset == 0:
                    cur_tab.follow_bottom = True
                render_event.set()
                continue

            # Variant voting mode
            if state.awaiting_vote_selection:
                if ch == "1":
                    if cur_tab and cur_tab.pending_variant_choice:
                        apply_user_variant_choice(cur_tab, 0)
                    state.awaiting_vote_selection = False
                elif ch == "2":
                    if cur_tab and cur_tab.pending_variant_choice:
                        apply_user_variant_choice(cur_tab, 1)
                    state.awaiting_vote_selection = False
                elif ch in ("\x1b", "q", "c", " "):
                    state.awaiting_vote_selection = False
                render_event.set()
                continue

            # Toggle variant voting mode
            if ch in ("v", "V"):
                if cur_tab and cur_tab.pending_variant_choice:
                    state.awaiting_vote_selection = True
                    state.add_log("⚖️ [bold yellow]Select variant: press [1] for Option 1, [2] for Option 2[/bold yellow]")
                else:
                    state.add_log("[dim]No pending variant vote on current tab[/dim]")
                render_event.set()
                continue

            # Export JSON
            if ch in ("e", "E"):
                if cur_tab and cur_tab.writer:
                    try:
                        msg = json.dumps({"command": "trigger_export", "tabId": cur_tab.tab_id})
                        cur_tab.writer.write(make_ws_frame(msg))
                        asyncio.create_task(cur_tab.writer.drain())
                        state.add_log(f"📥 Requested export for [{cur_tab.tab_id}]")
                    except Exception as err:
                        state.add_log(f"[red]Failed triggering export: {escape(str(err))}[/red]")
                else:
                    state.add_log("[dim]Cannot export: no active tab connection[/dim]")
                render_event.set()
                continue

            # Tab navigation: arrows, h/l, Tab, Shift-Tab, 1-9
            if ch in ("\x1b[C", "\x1bOC", "l", "L", "\t"):
                if tabs_count:
                    state.user_manually_selected = True
                    state.selected_tab_idx = (state.selected_tab_idx + 1) % tabs_count
            elif ch in ("\x1b[D", "\x1bOD", "h", "H", "\x1b[Z"):
                if tabs_count:
                    state.user_manually_selected = True
                    state.selected_tab_idx = (state.selected_tab_idx - 1) % tabs_count
            elif ch.isdigit() and 1 <= int(ch) <= tabs_count:
                state.user_manually_selected = True
                state.selected_tab_idx = int(ch) - 1

            # Up / Down Scrolling (step = 3 lines)
            elif ch in ("\x1b[A", "\x1bOA", "k", "K"):
                if cur_tab:
                    cur_tab.follow_bottom = False
                    cur_tab.scroll_offset += 3
            elif ch in ("\x1b[B", "\x1bOB", "j", "J"):
                if cur_tab:
                    cur_tab.scroll_offset = max(0, cur_tab.scroll_offset - 3)
                    if cur_tab.scroll_offset == 0:
                        cur_tab.follow_bottom = True

            # Page Up / Half-page Up (step = 15 lines)
            elif ch in ("u", "U", "\x15", "\x02", "\x1b[5~"):
                if cur_tab:
                    cur_tab.follow_bottom = False
                    cur_tab.scroll_offset += 15

            # Page Down / Half-page Down (step = 15 lines)
            elif ch in ("d", "D", "\x04", "\x06", "\x1b[6~"):
                if cur_tab:
                    cur_tab.scroll_offset = max(0, cur_tab.scroll_offset - 15)
                    if cur_tab.scroll_offset == 0:
                        cur_tab.follow_bottom = True

            # Top of chat
            elif ch in ("g", "\x1b[H", "\x1b[1~"):
                if cur_tab:
                    cur_tab.follow_bottom = False
                    cur_tab.scroll_offset = 999999

            # Bottom of chat
            elif ch in ("G", "\x1b[F", "\x1b[4~"):
                if cur_tab:
                    cur_tab.scroll_offset = 0
                    cur_tab.follow_bottom = True

            # Quit
            elif ch in ("q", "Q", "\x03"):
                state.stop_requested = True
                render_event.set()
                break

            render_event.set()
