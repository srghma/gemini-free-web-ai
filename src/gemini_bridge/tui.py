import asyncio
import os
import select
import sys
import termios
import time
import tty
from rich.console import Console, Group
from rich.layout import Layout
from rich.markup import escape
from rich.panel import Panel
from rich.segment import Segment, Segments
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text
from .models import ServerState, TabSession

console = Console()

def get_char_nonblocking(fd: int, timeout: float = 0.2) -> str | None:
    try:
        r, _, _ = select.select([fd], [], [], timeout)
        if r:
            return os.read(fd, 32).decode("utf-8", errors="ignore")
    except Exception:
        pass
    return None

def render_chat_view(selected_tab: TabSession | None, width: int, height: int) -> Panel:
    if not selected_tab or not selected_tab.turns:
        return Panel(
            Text("\n\n  Waiting for chat activity in this tab...", style="dim italic"),
            title="[bold cyan]Chat View[/bold cyan]",
            border_style="magenta",
        )

    elements = []
    for turn in selected_tab.turns:
        if turn.type == "user" and turn.user_content:
            elements.append(
                Panel(Text(turn.user_content, style="white"), title=f"👤 USER ({turn.id[-6:]})", border_style="cyan")
            )

        if turn.thinking_content:
            status_txt = "streaming..." if turn.status == "streaming" else "settled"
            elements.append(
                Panel(
                    Text(turn.thinking_content, style="italic magenta"),
                    title=f"💭 THINKING ({status_txt})",
                    border_style="dim magenta",
                )
            )

        if turn.chat_content or turn.code_blocks:
            status_txt = "streaming..." if turn.status == "streaming" else "ready"
            if turn.chat_content:
                elements.append(
                    Panel(Text(turn.chat_content, style="white"), title=f"🤖 AI RESPONSE ({status_txt})", border_style="green")
                )

            for cb in turn.code_blocks:
                lang = (cb.language or "bash").lower()
                syntax = Syntax(cb.code, lang, theme="monokai", line_numbers=True, word_wrap=True)
                elements.append(Panel(syntax, title=f"⚡ PAYLOAD: {lang.upper()}", border_style="yellow"))

    if selected_tab.preference_vote:
        vote = selected_tab.preference_vote
        vote_lines = [f"[bold yellow]⚖️ Preference Vote Pending ({len(vote.options)} options)[/bold yellow]"]
        for opt in vote.options:
            vote_lines.append(f"  • Option {opt.index + 1} ({opt.side}): {opt.text[:80]}...")
        elements.append(Panel(Text.from_markup("\n".join(vote_lines)), title="⚖️ PREFERENCE VOTE", border_style="yellow"))

    inner_width = max(20, width - 4)
    inner_height = max(5, height - 2)

    group = Group(*elements)
    rendered_lines = list(console.render_lines(group, console.options.update(width=inner_width)))
    total_lines = len(rendered_lines)

    max_offset = max(0, total_lines - inner_height)
    offset = 0 if selected_tab.follow_bottom else min(selected_tab.scroll_offset, max_offset)

    if total_lines <= inner_height:
        visible = rendered_lines
    elif offset == 0:
        visible = rendered_lines[-inner_height:]
    else:
        start = max(0, total_lines - inner_height - offset)
        end = max(0, total_lines - offset)
        visible = rendered_lines[start:end]

    flat = []
    for line in visible:
        flat.extend(line)
        flat.append(Segment.line())

    status_tag = (
        "[green]▼ Follow Bottom[/green]"
        if (selected_tab.follow_bottom or offset == 0)
        else f"[yellow]▲ Scrolled +{offset} lines (G to bottom)[/yellow]"
    )
    title = f"[bold cyan]Selected Tab: {escape(selected_tab.title)}[/bold cyan] ({total_lines} lines) • {status_tag}"

    return Panel(Segments(flat), title=title, border_style="magenta")

def render_tui(height: int, state: ServerState, execution_queue: asyncio.Queue) -> Layout:
    layout = Layout()
    layout.split_row(
        Layout(name="chat_view", ratio=6),
        Layout(name="sidebar", ratio=4),
    )

    layout["sidebar"].split_column(
        Layout(name="header", size=4),
        Layout(name="tabs_bar", size=4),
        Layout(name="active_task", size=4),
        Layout(name="composer", size=5),
        Layout(name="logs", ratio=1),
        Layout(name="footer", size=3),
    )

    selected_tab = state.get_selected_tab()

    chat_width = max(30, int(console.width * 0.6))
    layout["chat_view"].update(render_chat_view(selected_tab, chat_width, height))

    active_count = len(state.tabs)
    q_depth = execution_queue.qsize()
    header_content = (
        f"[bold magenta]⚡ GEMINI BRIDGE TUI MULTIPLEXER[/bold magenta]\n"
        f"Tabs: [cyan]{active_count}[/cyan] │ Queue: [yellow]{q_depth}[/yellow] "
        f"│ Done: [green]{state.tasks_completed}[/green] │ Fail: [red]{state.tasks_failed}[/red]"
    )
    layout["sidebar"]["header"].update(Panel(Text.from_markup(header_content), border_style="cyan"))

    tab_list = state.tab_list
    tab_cells = []
    if not tab_list:
        tab_cells.append(Text("(No Chrome tabs connected - waiting on ws://127.0.0.1:8765)", style="dim italic"))
    else:
        for idx, tab in enumerate(tab_list):
            is_active = idx == state.selected_tab_idx
            status_ico = "✍" if tab.is_printing else "⏸"
            title = (tab.title[:10] + "…") if len(tab.title) > 10 else tab.title

            cell_text = f"[{idx + 1}] {tab.tab_id} ({title}) {status_ico}"
            if is_active:
                tab_cells.append(Text(f" ❯ {cell_text} ", style="bold white on #2d3748"))
            else:
                tab_cells.append(Text(f"   {cell_text} ", style="dim"))

    tabs_table = Table.grid(padding=(0, 1))
    tabs_table.add_row(*tab_cells)
    layout["sidebar"]["tabs_bar"].update(Panel(tabs_table, title="[bold]Active Chrome Tabs[/bold]", border_style="dim"))

    cur_task = state.current_executing_task
    if cur_task:
        task_tab = escape(f"[{cur_task['tab_id']}]")
        step_str = f"({cur_task.get('idx', 1)}/{cur_task.get('total', 1)}) " if 'total' in cur_task else ""
        exec_banner = (
            f"[bold yellow]▶ ACTIVE: {step_str}{cur_task['lang'].upper()} on {task_tab}[/bold yellow]\n"
            f"[dim]Running for {time.time() - cur_task['start']:.1f}s (timeout: {cur_task['timeout']:.0f}s)[/dim]"
        )
    else:
        exec_banner = "[dim]Queue idle - waiting for tasks[/dim]"
    layout["sidebar"]["active_task"].update(Panel(Text.from_markup(exec_banner), title="[bold]Active Task[/bold]", border_style="yellow" if cur_task else "dim"))

    if selected_tab and selected_tab.prompt_text:
        p_text = (selected_tab.prompt_text[:120] + "...") if len(selected_tab.prompt_text) > 120 else selected_tab.prompt_text
        composer_content = Text(f"✍️ ({len(selected_tab.prompt_text)} chars): {p_text}", style="italic cyan")
    else:
        composer_content = Text("Prompt box empty", style="dim italic")
    layout["sidebar"]["composer"].update(Panel(composer_content, title="[bold]Composer Preview (Live)[/bold]", border_style="cyan"))

    log_lines = list(state.logs)[-8:]
    log_texts = [Text.from_markup(l) for l in log_lines] or [Text("Waiting for events...", style="dim")]
    layout["sidebar"]["logs"].update(Panel(Group(*log_texts), title="[bold]Central Queue & Logs[/bold]", border_style="dim"))

    nav_hint = escape("[q] Quit │ [1-9]/[h/l] Tabs │ [j/k]/[↑/↓] Scroll │ [G] Bottom")
    layout["sidebar"]["footer"].update(Panel(Text.from_markup(f"[dim]{nav_hint}[/dim]"), border_style="dim"))

    return layout

async def key_listener(state: ServerState, render_event: asyncio.Event):
    loop = asyncio.get_running_loop()
    fd = sys.stdin.fileno()
    is_tty = os.isatty(fd)
    old_settings = None

    if is_tty:
        try:
            old_settings = termios.tcgetattr(fd)
            tty.setcbreak(fd)
        except Exception:
            old_settings = None

    try:
        while not state.stop_requested:
            ch = await loop.run_in_executor(None, get_char_nonblocking, fd, 0.2)
            if not ch:
                continue

            tabs_count = len(state.tabs)
            cur_tab = state.get_selected_tab()

            # Arrow keys & Escape sequences
            if ch in ("\x1b[C", "l", "L", "\t"):
                if tabs_count:
                    state.user_manually_selected = True
                    state.selected_tab_idx = (state.selected_tab_idx + 1) % tabs_count
            elif ch in ("\x1b[D", "h", "H", "\x7f"):
                if tabs_count:
                    state.user_manually_selected = True
                    state.selected_tab_idx = (state.selected_tab_idx - 1) % tabs_count
            elif ch.isdigit() and 1 <= int(ch) <= tabs_count:
                state.user_manually_selected = True
                state.selected_tab_idx = int(ch) - 1

            # Up / Down Scrolling
            elif ch in ("\x1b[A", "k", "K"):
                if cur_tab:
                    cur_tab.follow_bottom = False
                    cur_tab.scroll_offset += 4
            elif ch in ("\x1b[B", "j", "J"):
                if cur_tab:
                    cur_tab.scroll_offset = max(0, cur_tab.scroll_offset - 4)
                    if cur_tab.scroll_offset == 0:
                        cur_tab.follow_bottom = True
            elif ch in ("u", "U", "\x1b[5~"):  # Page up
                if cur_tab:
                    cur_tab.follow_bottom = False
                    cur_tab.scroll_offset += 16
            elif ch in ("d", "D", "\x1b[6~"):  # Page down
                if cur_tab:
                    cur_tab.scroll_offset = max(0, cur_tab.scroll_offset - 16)
                    if cur_tab.scroll_offset == 0:
                        cur_tab.follow_bottom = True
            elif ch in ("g", "\x1b[H"):        # Top
                if cur_tab:
                    cur_tab.follow_bottom = False
                    cur_tab.scroll_offset = 99999
            elif ch in ("G", "\x1b[F"):        # Bottom
                if cur_tab:
                    cur_tab.scroll_offset = 0
                    cur_tab.follow_bottom = True

            elif ch in ("q", "Q", "\x03", "\x04"):
                state.stop_requested = True
                render_event.set()
                break

            render_event.set()
    finally:
        if is_tty and old_settings:
            try:
                termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
            except Exception:
                pass
