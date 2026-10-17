import asyncio
import time
import readchar
from readchar import key as K
from rich.console import Console, Group
from rich.layout import Layout
from rich.markup import escape
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from models import ServerState

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

def render_tui(height: int, state: ServerState, execution_queue: asyncio.Queue) -> Layout:
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
        f"[bold magenta]⚡ GEMINI BRIDGE TUI MULTIPLEXER[/bold magenta] [dim]• ws://127.0.0.1:8765[/dim] "
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
    switch_hint = escape("[1-9] / [h/l] Switch")
    layout["tabs_bar"].update(Panel(tabs_table, title=f"[bold]Active Chrome Tabs[/bold] [dim]({switch_hint})[/dim]", border_style="dim"))

    # 3. Main Stream View (renders last 8-10 turns + live prompt stream)
    selected_tab = state.get_selected_tab()
    if not selected_tab or not selected_tab.turns:
        view_content = Text("\n\n  Waiting for chat activity in this tab...", style="dim italic")
    else:
        elements = []
        for turn in selected_tab.turns[-10:]:
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

        # Real-time Composer Preview
        if selected_tab.prompt_text:
            elements.append(Text("✍️ PROMPT BOX (LIVE STREAM):", style="bold cyan"))
            p_text = (selected_tab.prompt_text[:300] + "...") if len(selected_tab.prompt_text) > 300 else selected_tab.prompt_text
            elements.append(Panel(Text(p_text, style="italic cyan"), border_style="cyan"))

        view_content = Group(*elements)

    curr_title = selected_tab.title if selected_tab else "No Tab"
    layout["main_view"].update(Panel(view_content, title=f"[bold cyan]Selected Tab: {escape(curr_title)}[/bold cyan]", border_style="magenta"))

    # 4. Bottom Activity & Logs
    log_lines = list(state.logs)[-5:]
    log_texts = [Text.from_markup(l) for l in log_lines] or [Text("Waiting for events...", style="dim")]

    cur_task = state.current_executing_task
    if cur_task:
        task_tab = escape(f"[{cur_task['tab_id']}]")
        exec_banner = f"[bold yellow]▶ ACTIVE TASK: {cur_task['lang'].upper()} on {task_tab}[/bold yellow] [dim]({time.time() - cur_task['start']:.1f}s)[/dim]"
    else:
        exec_banner = "[dim]Queue idle[/dim]"

    nav_hint = escape("[q] Quit, [h/l] Tabs")
    layout["bottom_bar"].update(
        Panel(
            Group(Text.from_markup(exec_banner), *log_texts),
            title=f"[bold]Central Queue & Logs[/bold] [dim]({nav_hint})[/dim]",
            border_style="dim",
        )
    )

    return layout

async def key_listener(state: ServerState, render_event: asyncio.Event):
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
