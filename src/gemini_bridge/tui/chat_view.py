from pathlib import Path
from rich.console import Group
from rich.markup import escape
from rich.panel import Panel
from rich.segment import Segment, Segments
from rich.syntax import Syntax
from rich.text import Text

from ..models import ChatTurn, PreferenceVote, TabSession
from .console import console

def render_turn_panels(turn: ChatTurn) -> list[Panel]:
    panels: list[Panel] = []

    if turn.type == "user" and turn.user_content:
        panels.append(
            Panel(
                Text(turn.user_content, style="white"),
                title=f"👤 USER ({turn.id[-6:]})",
                border_style="cyan",
            )
        )

    if turn.thinking_content:
        status_txt = "streaming..." if turn.status == "streaming" else "settled"
        panels.append(
            Panel(
                Text(turn.thinking_content, style="italic magenta"),
                title=f"💭 THINKING ({status_txt})",
                border_style="dim magenta",
            )
        )

    if turn.chat_content or turn.code_blocks:
        status_txt = "streaming..." if turn.status == "streaming" else "ready"
        if turn.chat_content:
            panels.append(
                Panel(
                    Text(turn.chat_content, style="white"),
                    title=f"🤖 AI RESPONSE ({status_txt})",
                    border_style="green",
                )
            )

        for cb in turn.code_blocks:
            lang = (cb.language or "bash").lower()
            syntax = Syntax(cb.code, lang, theme="monokai", line_numbers=True, word_wrap=True)
            panels.append(
                Panel(syntax, title=f"⚡ PAYLOAD: {lang.upper()}", border_style="yellow")
            )

    return panels

def render_preference_vote_panel(vote: PreferenceVote) -> Panel:
    v_title = "[bold yellow blink]⚖️ A/B PREFERENCE VOTE PENDING - ACTION REQUIRED[/bold yellow blink]"
    v_lines = [
        f"[bold yellow]{vote.question}[/bold yellow]",
        "[bold cyan]Press [v] followed by [1] or [2] to select candidate:[/bold cyan]\n",
    ]

    for idx, opt in enumerate(vote.options):
        preview = opt.text.strip()
        if len(preview) > 300:
            preview = f"{preview[:300]}..."
        v_lines.append(
            f"[bold green][{idx + 1}] Option {idx + 1} ({opt.side.upper()}):[/bold green]\n{preview}\n"
        )

    return Panel(Text.from_markup("\n".join(v_lines)), title=v_title, border_style="yellow")

def slice_visible_lines(rendered_lines: list, inner_height: int, offset: int) -> list:
    total_lines = len(rendered_lines)
    if total_lines <= inner_height:
        return rendered_lines
    if offset == 0:
        return rendered_lines[-inner_height:]
    start = max(0, total_lines - inner_height - offset)
    end = max(0, total_lines - offset)
    return rendered_lines[start:end]

def render_chat_view(selected_tab: TabSession | None, width: int, height: int) -> Panel:
    if not selected_tab or (not selected_tab.turns and not selected_tab.pending_variant_choice):
        return Panel(
            Text("\n\n  Waiting for chat activity in this tab...", style="dim italic"),
            title="[bold cyan]Chat View[/bold cyan]",
            border_style="magenta",
        )

    elements = []
    for turn in selected_tab.turns:
        elements.extend(render_turn_panels(turn))

    if selected_tab.pending_variant_choice:
        elements.append(render_preference_vote_panel(selected_tab.pending_variant_choice))

    inner_width = max(20, width - 4)
    inner_height = max(5, height - 2)

    group = Group(*elements)
    rendered_lines = list(
        console.render_lines(group, console.options.update(width=inner_width, height=None))
    )
    total_lines = len(rendered_lines)

    max_offset = max(0, total_lines - inner_height)
    if selected_tab.follow_bottom:
        offset = 0
        selected_tab.scroll_offset = 0
    else:
        offset = min(selected_tab.scroll_offset, max_offset)
        selected_tab.scroll_offset = offset

    visible = slice_visible_lines(rendered_lines, inner_height, offset)

    flat: list[Segment] = []
    for line in visible:
        flat.extend(line)
        flat.append(Segment.line())

    home_dir = str(Path.home())
    cwd_disp = escape(selected_tab.cwd.replace(home_dir, "~")) if selected_tab.cwd else "~"

    if selected_tab.follow_bottom or offset == 0:
        status_tag = f"[bold green]▼ Follow Bottom[/bold green] ({total_lines} lines)"
    else:
        pct = int(((max_offset - offset) / max_offset) * 100) if max_offset > 0 else 100
        status_tag = f"[bold yellow]▲ Scrolled +{offset}/{max_offset} ({pct}%) [G to bottom][/bold yellow]"

    title = f"[bold cyan]{escape(selected_tab.title)}[/bold cyan] │ 📂 [yellow]{cwd_disp}[/yellow] │ {status_tag}"

    return Panel(Segments(flat), title=title, border_style="magenta")
