import asyncio
import json
import random
import time
from rich.markup import escape
from .executor import execute_task, parse_timeout
from .formatter import format_execution_reply, group_replies
from .models import ChatTurn, PreferenceOption, PreferenceVote, ServerState, TabSession, render_event, state
from .parser import ParsedCommand, extract_commands_from_turn
from .transport import log_raw_ws, log_to_file, make_ws_frame

class CommandBatch:
    def __init__(self, tab_id: str, writer: asyncio.StreamWriter, commands: list[ParsedCommand]):
        self.tab_id = tab_id
        self.writer = writer
        self.commands = commands

execution_queue: asyncio.Queue[CommandBatch] = asyncio.Queue()

async def batch_queue_worker():
    while not state.stop_requested:
        batch = await execution_queue.get()
        tab_id = batch.tab_id
        writer = batch.writer
        total = len(batch.commands)

        tab_tag = escape(f"[{tab_id}]")
        state.add_log(f"⚡ [yellow]Processing batch of {total} command(s) for {tab_tag}[/yellow]")
        render_event.set()

        replies: list[str] = []

        for idx, cmd in enumerate(batch.commands):
            lang = cmd.lang.lower()
            code = cmd.code
            timeout = parse_timeout(cmd.timeout)
            start_time = time.time()

            state.current_executing_task = {
                "tab_id": tab_id,
                "lang": lang,
                "timeout": timeout,
                "start": start_time,
                "idx": idx + 1,
                "total": total,
            }
            state.add_log(f"🚀 [{idx + 1}/{total}] Executing {lang.upper()} ({timeout:.0f}s timeout)")
            render_event.set()

            log_to_file(f"EXECUTE [{tab_id}] ({idx + 1}/{total}) {lang.upper()} (timeout: {timeout}s)\n--- CODE ---\n{code}\n--- END CODE ---")
            log_raw_ws("EVENT", tab_id, f"TASK_START ({idx + 1}/{total}): {lang.upper()}")

            # Inform tab status badge
            try:
                running_frame = json.dumps({"status": "running", "type": lang, "timeout": f"{timeout}s"})
                writer.write(make_ws_frame(running_frame))
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

            state.add_log(f"{status_tag} {lang.upper()} in {elapsed:.2f}s")
            log_to_file(f"RESULT [{tab_id}] ({idx + 1}/{total}) Exit {res.exit_code} in {elapsed:.2f}s\n--- OUTPUT ---\n{res.output}\n--- END OUTPUT ---\n")
            log_raw_ws("EVENT", tab_id, f"TASK_END ({idx + 1}/{total}): Exit {res.exit_code} in {elapsed:.2f}s")

            replies.append(format_execution_reply(lang, res))
            render_event.set()

        # Group all replies and dispatch back to prompt box
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

        render_event.set()
        execution_queue.task_done()

def handle_preference_vote(session: TabSession, vote_dict: dict, writer: asyncio.StreamWriter):
    if not vote_dict:
        session.preference_vote = None
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

    vote_key = f"{len(options)}_{options[0].text[:30] if options else ''}"
    if vote_key in session.handled_vote_keys:
        return

    session.handled_vote_keys.add(vote_key)
    # Pick variant randomly between available options (0 or 1)
    chosen_idx = random.choice([0, 1]) if len(options) > 1 else 0
    tab_tag = escape(f"[{session.tab_id}]")
    state.add_log(f"⚖️ [bold yellow]Preference vote detected for {tab_tag}! Auto-selecting Variant #{chosen_idx + 1}[/bold yellow]")

    try:
        msg = json.dumps({"command": "select_variant", "tabId": session.tab_id, "variantIndex": chosen_idx})
        writer.write(make_ws_frame(msg))
        asyncio.create_task(writer.drain())
        log_raw_ws("SEND", session.tab_id, msg)
    except Exception as e:
        state.add_log(f"[red]Failed sending select_variant: {escape(str(e))}[/red]")
    render_event.set()

def check_and_dispatch_settled_turns(session: TabSession, writer: asyncio.StreamWriter):
    if session.is_printing or not session.turns:
        return

    latest_turn = session.turns[-1]
    # Check if latest turn is AI response (not user) and has not been handled yet
    if latest_turn.type == "user" or latest_turn.id in session.handled_turn_ids:
        return

    # Extract commands from this model turn
    commands = extract_commands_from_turn(latest_turn)
    session.handled_turn_ids.add(latest_turn.id)

    if commands:
        tab_tag = escape(f"[{session.tab_id}]")
        state.add_log(f"📥 Found [cyan]{len(commands)}[/cyan] command(s) in turn {latest_turn.id[-6:]} for {tab_tag}")
        execution_queue.put_nowait(CommandBatch(session.tab_id, writer, commands))
        render_event.set()
