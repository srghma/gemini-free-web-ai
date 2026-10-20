import asyncio
from rich.layout import Layout

from ..models import ServerState
from .chat_view import render_chat_view
from .console import console
from .sidebar import (
    render_active_task,
    render_composer_preview,
    render_footer,
    render_header,
    render_logs_panel,
    render_tabs_bar,
)

def render_tui(height: int, state: ServerState, execution_queue: asyncio.Queue) -> Layout:
    layout = Layout()
    layout.split_row(
        Layout(name="chat_view", ratio=6),
        Layout(name="sidebar", ratio=4),
    )

    layout["sidebar"].split_column(
        Layout(name="header", size=4),
        Layout(name="tabs_bar", size=4),
        Layout(name="active_task", size=7),
        Layout(name="composer", size=4),
        Layout(name="logs", ratio=1),
        Layout(name="footer", size=3),
    )

    selected_tab = state.get_selected_tab()
    chat_width = max(30, int(console.width * 0.6))

    layout["chat_view"].update(render_chat_view(selected_tab, chat_width, height))
    layout["sidebar"]["header"].update(render_header(state, execution_queue))
    layout["sidebar"]["tabs_bar"].update(render_tabs_bar(state))
    layout["sidebar"]["active_task"].update(render_active_task(state, selected_tab))
    layout["sidebar"]["composer"].update(render_composer_preview(selected_tab))
    layout["sidebar"]["logs"].update(render_logs_panel(state))
    layout["sidebar"]["footer"].update(render_footer(state))

    return layout
