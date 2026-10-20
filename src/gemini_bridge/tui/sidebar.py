import asyncio
import time
from rich.console import Group
from rich.markup import escape
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from ..models import ServerState, TabSession

def render_header(state: ServerState, execution_queue: asyncio.Queue) -> Panel:
    active_count = len(state.tabs)
    q_depth = execution_queue.qsize()
    header_content = (
        f"[bold magenta]⚡ GEMINI BRIDGE TUI MULTIPLEXER[/bold magenta]\n"
        f"Tabs: [cyan]{active_count}[/cyan] │ Queue: [yellow]{q_depth}[/yellow] "
        f"│ Done: [green]{state.tasks_completed}[/green] │ Fail: [red]{state.tasks_failed}[/red]"
    )
    return Panel(Text.from_markup(header_content), border_style="cyan")

def render_tabs_bar(state: ServerState) -> Panel:
    tab_list = state.tab_list
    tab_cells = []
    if not tab_list:
        tab_cells.append(
            Text("(No Chrome tabs connected - waiting on ws://127.0.0.1:8765)", style="dim italic")
        )
    else:
        for idx, tab in enumerate(tab_list):
            is_active = idx == state.selected_tab_idx
            status_ico = "⚖️" if tab.pending_variant_choice else ("✍" if tab.is_printing else "⏸")
            title = f"{tab.title[:10]}…" if len(tab.title) > 10 else tab.title

            cell_text = f"[{idx + 1}] {tab.tab_id} ({title}) {status_ico}"
            if is_active:
                tab_cells.append(Text(f" ❯ {cell_text} ", style="bold white on #2d3748"))
            else:
                tab_cells.append(Text(f"   {cell_text} ", style="dim"))

    tabs_table = Table.grid(padding=(0, 1))
    tabs_table.add_row(*tab_cells)
    return Panel(tabs_table, title="[bold]Active Chrome Tabs[/bold]", border_style="dim")

def render_active_task(state: ServerState, selected_tab: TabSession | None) -> Panel:
    cur_task = state.current_executing_task
    if cur_task:
        task_tab = escape(f"[{cur_task['tab_id']}]")
        step_str = (
            f"({cur_task.get('idx', 1)}/{cur_task.get('total', 1)}) "
            if "total" in cur_task
            else ""
        )
        elapsed = time.time() - cur_task["start"]
        exec_lines = [
            f"[bold yellow]▶ ACTIVE: {step_str}{cur_task['lang'].upper()} on {task_tab}[/bold yellow] "
            f"[dim]({elapsed:.1f}s / {cur_task['timeout']:.0f}s)[/dim]"
        ]
        tail = cur_task.get("tail", [])
        if tail:
            exec_lines.append("[dim]── live output ──[/dim]")
            for t_line in tail[-3:]:
                clipped = t_line[:55] + "…" if len(t_line) > 55 else t_line
                exec_lines.append(f"[dim cyan]› {escape(clipped)}[/dim cyan]")

        exec_banner = "\n".join(exec_lines)
        border_style = "yellow"
    elif selected_tab and selected_tab.pending_variant_choice:
        exec_banner = "[bold yellow blink]⚖️ Awaiting Variant Selection (Press v then 1/2)[/bold yellow blink]"
        border_style = "yellow"
    else:
        exec_banner = "[dim]Queue idle - waiting for tasks[/dim]"
        border_style = "dim"

    return Panel(Text.from_markup(exec_banner), title="[bold]Active Task[/bold]", border_style=border_style)

def render_composer_preview(selected_tab: TabSession | None) -> Panel:
    if selected_tab and selected_tab.prompt_text:
        p_text = (
            f"{selected_tab.prompt_text[:120]}..."
            if len(selected_tab.prompt_text) > 120
            else selected_tab.prompt_text
        )
        composer_content = Text(f"✍️ ({len(selected_tab.prompt_text)} chars): {p_text}", style="italic cyan")
    else:
        composer_content = Text("Prompt box empty", style="dim italic")

    return Panel(composer_content, title="[bold]Composer Preview (Live)[/bold]", border_style="cyan")

def render_logs_panel(state: ServerState) -> Panel:
    log_lines = list(state.logs)[-8:]
    log_texts = [Text.from_markup(l) for l in log_lines] or [Text("Waiting for events...", style="dim")]
    return Panel(Group(*log_texts), title="[bold]Central Queue & Logs[/bold]", border_style="dim")

def render_footer(state: ServerState) -> Panel:
    if state.awaiting_vote_selection:
        nav_hint = escape("[1] Pick Option 1 │ [2] Pick Option 2 │ [Esc] Cancel Vote Selection")
    else:
        nav_hint = escape(
            "[q] Quit │ [e] Export │ [v] Vote │ [↑/↓/Wheel/j/k] Scroll │ [PgUp/PgDn] │ [G] Bottom │ [1-9] Tab"
        )
    return Panel(Text.from_markup(f"[dim]{nav_hint}[/dim]"), border_style="dim")
