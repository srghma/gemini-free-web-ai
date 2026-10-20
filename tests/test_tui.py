import asyncio
from rich.console import Console
from gemini_bridge.models import (
    ChatTurn,
    CodeBlock,
    PreferenceOption,
    PreferenceVote,
    ServerState,
    TabSession,
)
from gemini_bridge.tui.chat_view import render_chat_view, slice_visible_lines
from gemini_bridge.tui.layout import render_tui
from gemini_bridge.tui.sidebar import (
    render_active_task,
    render_composer_preview,
    render_footer,
    render_header,
    render_logs_panel,
    render_tabs_bar,
)

def render_to_text(renderable) -> str:
    c = Console(record=True, width=120)
    c.print(renderable)
    return c.export_text()

def test_slice_visible_lines():
    lines = list(range(100))
    # When offset == 0, show bottom 30 lines
    assert slice_visible_lines(lines, inner_height=30, offset=0) == list(range(70, 100))
    # When offset == 10, show lines 60 to 90
    assert slice_visible_lines(lines, inner_height=30, offset=10) == list(range(60, 90))
    # When offset == 70 (top), show lines 0 to 30
    assert slice_visible_lines(lines, inner_height=30, offset=70) == list(range(0, 30))

def test_render_chat_view_empty_and_populated():
    session = TabSession(tab_id="tab_test", title="Test Tab")
    empty_panel = render_chat_view(session, width=80, height=30)
    assert "Waiting for chat activity" in render_to_text(empty_panel)

    session.turns.append(ChatTurn(
        id="turn_1",
        type="user",
        status="completed",
        user_content="Hello assistant",
        code_blocks=[]
    ))
    session.turns.append(ChatTurn(
        id="turn_2",
        type="ai_chat",
        status="completed",
        chat_content="Hello user, running task:",
        code_blocks=[CodeBlock(language="bash", code="echo 'test'")]
    ))
    panel = render_chat_view(session, width=80, height=30)
    text = render_to_text(panel)
    assert "Hello assistant" in text
    assert "echo 'test'" in text

def test_render_chat_view_with_vote():
    session = TabSession(tab_id="tab_vote", title="Vote Tab")
    session.pending_variant_choice = PreferenceVote(
        question="Which response?",
        options=[
            PreferenceOption(index=0, side="left", text="Left opt"),
            PreferenceOption(index=1, side="right", text="Right opt"),
        ]
    )
    panel = render_chat_view(session, width=80, height=30)
    text = render_to_text(panel)
    assert "PREFERENCE VOTE PENDING" in text
    assert "Which response?" in text
    assert "Option 1" in text
    assert "Option 2" in text

def test_sidebar_and_layout():
    state = ServerState()
    tab = TabSession(tab_id="tab_1", title="Alpha")
    tab.prompt_text = "Draft prompt"
    state.tabs["tab_1"] = tab
    queue = asyncio.Queue()

    header = render_header(state, queue)
    assert "GEMINI BRIDGE" in render_to_text(header)

    tabs_bar = render_tabs_bar(state)
    assert "tab_1" in render_to_text(tabs_bar)

    task_panel = render_active_task(state, tab)
    assert "Queue idle" in render_to_text(task_panel)

    composer = render_composer_preview(tab)
    assert "Draft prompt" in render_to_text(composer)

    logs = render_logs_panel(state)
    assert logs is not None

    footer = render_footer(state)
    assert "[q] Quit" in render_to_text(footer)

    layout = render_tui(height=35, state=state, execution_queue=queue)
    assert layout["chat_view"] is not None
    assert layout["sidebar"] is not None
