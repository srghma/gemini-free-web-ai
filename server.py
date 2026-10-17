#!/usr/bin/env -S uv run
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
from datetime import datetime
import hashlib
import json
import os
import time

from rich.markup import escape
from rich.live import Live

from executor import execute_task, parse_timeout
from models import ChatTurn, TabSession, execution_queue, render_event, state
from tui import console, key_listener, render_tui
from ws_transport import (
    HOST,
    LOCK_FILE_PATH,
    PORT,
    WS_GUID,
    acquire_singleton_lock,
    log_to_file,
    make_ws_frame,
    read_ws_frame,
)

async def queue_worker():
    while not state.stop_requested:
        writer, task = await execution_queue.get()
        start_time = time.time()
        lang = task.get("type", "python").lower()
        code = task.get("code", "")
        timeout = parse_timeout(task.get("timeout"))
        tab_id = task.get("tabId", "unknown")

        state.current_executing_task = {"tab_id": tab_id, "lang": lang, "timeout": timeout, "start": start_time}
        tab_tag = escape(f"[{tab_id}]")
        state.add_log(f"🚀 [bold yellow]Executing {lang.upper()}[/bold yellow] for {tab_tag} ({timeout:.0f}s timeout)")
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
        state.add_log(f"{status_tag} {tab_tag} {lang.upper()} in {elapsed:.2f}s")
        render_event.set()
        execution_queue.task_done()

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

    current_tab_id: str | None = None

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
                current_tab_id = data.get("tabId")
                if current_tab_id:
                    session = state.tabs.setdefault(current_tab_id, TabSession(tab_id=current_tab_id))
                    session.title = data.get("title", "Chat")
                    session.prompt_text = data.get("promptText", "")
                    session.button_label = data.get("buttonLabel", "Run")
                    session.last_seen = datetime.now()

                    raw_turns = data.get("turns", [])
                    if raw_turns:
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

                    tab_tag = escape(f"[{current_tab_id}]")
                    state.add_log(f"🟢 [green]Chrome tab connected: {tab_tag} ({escape(session.title)}) - {len(session.turns)} turns[/green]")
                    render_event.set()

            elif event == "tab_chat_update":
                tab_id = data.get("tabId") or current_tab_id
                if not tab_id:
                    continue
                session = state.tabs.setdefault(tab_id, TabSession(tab_id=tab_id))
                session.is_printing = data.get("isPrinting", False)
                session.button_label = data.get("buttonLabel", "Run")
                session.prompt_text = data.get("promptText", "")
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

                if not state.user_manually_selected and session.turns:
                    cur_sel = state.get_selected_tab()
                    if not cur_sel or not cur_sel.turns:
                        try:
                            state.selected_tab_idx = list(state.tabs.keys()).index(tab_id)
                        except ValueError:
                            pass

                render_event.set()

            elif event == "tab_disconnected":
                tab_id = data.get("tabId") or current_tab_id
                if tab_id and tab_id in state.tabs:
                    state.tabs.pop(tab_id, None)
                    tab_tag = escape(f"[{tab_id}]")
                    state.add_log(f"⚪ [dim]Tab disabled manually by user: {tab_tag}[/dim]")
                    if state.tabs:
                        state.selected_tab_idx = max(0, min(state.selected_tab_idx, len(state.tabs) - 1))
                    else:
                        state.selected_tab_idx = 0
                    render_event.set()

            elif event == "variants_proposed":
                tab_id = data.get("tabId") or current_tab_id
                tab_tag = escape(f"[{tab_id}]")
                state.add_log(f"⚖️ [bold yellow]Two variants proposed for {tab_tag}! Auto-selecting Variant 1[/bold yellow]")
                writer.write(make_ws_frame(json.dumps({"command": "select_variant", "tabId": tab_id, "variantIndex": 0})))
                await writer.drain()
                render_event.set()

            elif "command" in data:
                sender_tab = data.get("tabId") or current_tab_id or "unknown"
                tab_tag = escape(f"[{sender_tab}]")
                await execution_queue.put((writer, data))
                state.add_log(f"📥 Queued {data.get('type', '').upper()} from {tab_tag}")
                render_event.set()

    except Exception:
        pass
    finally:
        if current_tab_id and current_tab_id in state.tabs:
            state.tabs.pop(current_tab_id, None)
            tab_tag = escape(f"[{current_tab_id}]")
            state.add_log(f"⚪ [dim]Chrome tab closed: {tab_tag}[/dim]")
            if state.tabs:
                state.selected_tab_idx = max(0, min(state.selected_tab_idx, len(state.tabs) - 1))
            else:
                state.selected_tab_idx = 0
            render_event.set()
        writer.close()
        await writer.wait_closed()

async def main():
    worker_task = asyncio.create_task(queue_worker())
    key_task = asyncio.create_task(key_listener(state, render_event))
    server = await asyncio.start_server(handle_client, HOST, PORT)
    state.add_log(f"Server listening on ws://{HOST}:{PORT}")

    with Live(render_tui(console.size.height, state, execution_queue), console=console, screen=True, auto_refresh=False) as live:
        try:
            while not state.stop_requested:
                live.update(render_tui(console.size.height, state, execution_queue), refresh=True)
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
