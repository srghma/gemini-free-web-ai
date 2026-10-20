import asyncio
from collections import deque
import json
import time
from rich.markup import escape
from .executor import ExecutionResult, execute_cd, execute_task, execute_write, parse_timeout
from .formatter import format_execution_reply, group_replies
from .models import (
    ChatTurn,
    PreferenceOption,
    PreferenceVote,
    ServerState,
    TabSession,
    extract_fenced_code_blocks,
    render_event,
    state,
)
from .parser import ParsedCommand, extract_commands_from_turn
from .transport import log_raw_ws, log_to_file, make_ws_frame

class CommandBatch:
    def __init__(self, tab_id: str, writer: asyncio.StreamWriter, commands: list[ParsedCommand]):
        self.tab_id = tab_id
        self.writer = writer
        self.commands = commands

execution_queue: asyncio.Queue[CommandBatch] = asyncio.Queue()

async def trigger_desktop_notification(title: str, body: str):
    try:
        proc = await asyncio.create_subprocess_exec("notify-send", "-u", "critical", title, body)
        await proc.wait()
    except Exception:
        pass

async def dispatch_command(
    cmd: ParsedCommand,
    session: TabSession | None,
    timeout: float,
    on_chunk=None,
) -> ExecutionResult:
    lang = cmd.lang.lower()
    if lang == "cd":
        return execute_cd(session, cmd.code) if session else ExecutionResult("[e]No session", False, 1)
    if lang == "write_next":
        return (
            execute_write(session, cmd.path, cmd.code, cmd.overwrite)
            if session
            else ExecutionResult("[e]No session", False, 1)
        )
    return await execute_task(lang, cmd.code, timeout, cwd=session.cwd if session else None, on_chunk=on_chunk)

async def batch_queue_worker():
    while not state.stop_requested:
        batch = await execution_queue.get()
        if not batch or not isinstance(batch, CommandBatch):
            execution_queue.task_done()
            continue

        tab_id = batch.tab_id
        writer = batch.writer
        total = len(batch.commands)

        tab_tag = escape(f"[{tab_id}]")
        state.add_log(f"⚡ [yellow]Processing batch of {total} command(s) for {tab_tag}[/yellow]")
        render_event.set()

        session = state.tabs.get(tab_id)
        replies: list[str] = []

        for idx, cmd in enumerate(batch.commands):
            lang = cmd.lang.lower()
            code = cmd.code
            timeout = parse_timeout(cmd.timeout)
            start_time = time.time()

            tail_buffer = deque(maxlen=4)

            def handle_chunk(stream_type: str, text: str):
                for line in text.splitlines():
                    if line.strip():
                        prefix = "[e]" if stream_type == "e" else ""
                        tail_buffer.append(f"{prefix}{line}")
                if state.current_executing_task:
                    state.current_executing_task["tail"] = list(tail_buffer)
                    render_event.set()

            state.current_executing_task = {
                "tab_id": tab_id,
                "lang": lang,
                "timeout": timeout,
                "start": start_time,
                "idx": idx + 1,
                "total": total,
                "tail": [],
            }
            state.add_log(f"🚀 [{idx + 1}/{total}] Executing {lang.upper()}")
            render_event.set()

            log_to_file(f"EXECUTE [{tab_id}] ({idx + 1}/{total}) {lang.upper()}\n--- CODE ---\n{code}\n--- END CODE ---")
            log_raw_ws("EVENT", tab_id, f"TASK_START ({idx + 1}/{total}): {lang.upper()}")

            try:
                running_frame = json.dumps({"status": "running", "type": lang, "timeout": f"{timeout}s"})
                writer.write(make_ws_frame(running_frame))
                await writer.drain()
            except Exception:
                pass

            res = await dispatch_command(cmd, session, timeout, on_chunk=handle_chunk)
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

            state.add_log(f"{status_tag} {lang.upper()} in {elapsed:.2f}s")
            log_to_file(f"RESULT [{tab_id}] ({idx + 1}/{total}) Exit {res.exit_code} in {elapsed:.2f}s\n--- OUTPUT ---\n{res.output}\n--- END OUTPUT ---\n")
            log_raw_ws("EVENT", tab_id, f"TASK_END ({idx + 1}/{total}): Exit {res.exit_code} in {elapsed:.2f}s")

            reply = format_execution_reply(lang, res, tab_id=tab_id)
            if reply:
                replies.append(reply)
            render_event.set()

            if not is_ok:
                state.add_log(f"⚠️ [bold red]Command {idx + 1}/{total} failed, aborting remaining commands in batch[/bold red]")
                break

        composite_reply = group_replies(replies)
        if composite_reply:
            try:
                submit_payload = json.dumps({
                    "command": "submit_prompt",
                    "tabId": tab_id,
                    "text": composite_reply,
                })
                writer.write(make_ws_frame(submit_payload))
                await writer.drain()
                log_raw_ws("SEND", tab_id, submit_payload)
                state.add_log(f"📤 [bold green]Dispatched grouped replies ({total} cmds) to prompt box {tab_tag}[/bold green]")
            except Exception as e:
                state.add_log(f"[red]Failed sending grouped reply to {tab_tag}: {escape(str(e))}[/red]")
        else:
            state.add_log(f"✓ [dim]Batch completed with no reply output for {tab_tag}[/dim]")

        render_event.set()
        execution_queue.task_done()

def handle_preference_vote(session: TabSession, vote_dict: dict | None, writer: asyncio.StreamWriter):
    if not vote_dict:
        session.preference_vote = None
        session.pending_variant_choice = None
        return

    options = [
        PreferenceOption(index=opt.get("index", idx), side=opt.get("side", "left"), text=opt.get("text", ""))
        for idx, opt in enumerate(vote_dict.get("options", []))
    ]
    vote = PreferenceVote(
        question=vote_dict.get("question", "Which response do you prefer?"),
        options=options,
        has_submit_button=vote_dict.get("hasSubmitButton", True),
        is_submit_disabled=vote_dict.get("isSubmitDisabled", False),
    )
    session.preference_vote = vote
    session.pending_variant_choice = vote

    vote_key = f"{len(options)}_{options[0].text[:30] if options else ''}"
    if vote_key in session.handled_vote_keys:
        return

    session.handled_vote_keys.add(vote_key)
    tab_tag = escape(f"[{session.tab_id}]")
    state.add_log(f"⚖️ [bold yellow]A/B Variant Choice Required for {tab_tag}! Press [v] in TUI to select.[/bold yellow]")

    asyncio.create_task(
        trigger_desktop_notification(
            "Gemini Bridge: A/B Choice Required",
            f"Select Variant [1] or [2] in TUI for tab {session.tab_id}"
        )
    )
    render_event.set()

def apply_user_variant_choice(session: TabSession, variant_idx: int):
    if not session.pending_variant_choice or not session.writer:
        return

    opts = session.pending_variant_choice.options
    if variant_idx < 0 or variant_idx >= len(opts):
        return

    chosen_opt = opts[variant_idx]
    chosen_text = chosen_opt.text
    tab_tag = escape(f"[{session.tab_id}]")
    state.add_log(f"⚖️ [bold cyan]User selected Variant #{variant_idx + 1} ({chosen_opt.side}) for {tab_tag}[/bold cyan]")

    try:
        msg = json.dumps({
            "command": "select_variant",
            "tabId": session.tab_id,
            "variantIndex": variant_idx,
            "selectedText": chosen_text,
        })
        session.writer.write(make_ws_frame(msg))
        asyncio.create_task(session.writer.drain())
        log_raw_ws("SEND", session.tab_id, msg)
    except Exception as e:
        state.add_log(f"[red]Failed sending select_variant: {escape(str(e))}[/red]")

    turn_id = f"net_turn_{len(session.turns)}"
    committed_turn = ChatTurn(
        id=turn_id,
        type="ai_chat",
        status="completed",
        chat_content=chosen_text,
        code_blocks=extract_fenced_code_blocks(chosen_text),
    )
    session.turns.append(committed_turn)
    session.handled_turn_ids.add(turn_id)

    session.pending_variant_choice = None
    session.preference_vote = None

    commands = extract_commands_from_turn(committed_turn)
    if commands:
        state.add_log(f"📥 Found [cyan]{len(commands)}[/cyan] command(s) in selected variant for {tab_tag}")
        execution_queue.put_nowait(CommandBatch(session.tab_id, session.writer, commands))
    else:
        state.add_log(f"✓ No execution triggers in selected variant for {tab_tag}")

    render_event.set()

def check_and_dispatch_settled_turns(session: TabSession, writer: asyncio.StreamWriter):
    if session.is_printing or not session.turns or session.pending_variant_choice:
        return

    latest_turn = session.turns[-1]
    if latest_turn.type == "user" or latest_turn.id in session.handled_turn_ids:
        return

    commands = extract_commands_from_turn(latest_turn)
    session.handled_turn_ids.add(latest_turn.id)

    if commands:
        tab_tag = escape(f"[{session.tab_id}]")
        state.add_log(f"📥 Found [cyan]{len(commands)}[/cyan] command(s) in turn {latest_turn.id[-6:]} for {tab_tag}")
        execution_queue.put_nowait(CommandBatch(session.tab_id, writer, commands))
        render_event.set()
