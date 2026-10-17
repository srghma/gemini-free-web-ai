import asyncio
import base64
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys
from rich.markup import escape
from rich.live import Live

from .models import TabSession, render_event, state
from .orchestrator import (
    batch_queue_worker,
    check_and_dispatch_settled_turns,
    execution_queue,
    handle_preference_vote,
)
from .transport import (
    HOST,
    LOCK_FILE_PATH,
    PORT,
    WS_GUID,
    WatcherLock,
    log_raw_ws,
    make_ws_frame,
    read_ws_frame,
)
from .tui import console, key_listener, render_tui

EXPORTS_DIR = Path.home() / "projects" / "gemini-free-web-ai" / "exports"

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
    log_raw_ws("CONNECT", "server", "New client TCP connection established")

    try:
        while True:
            raw_msg = await read_ws_frame(reader, writer)
            if raw_msg is None:
                break
            if not raw_msg:
                continue

            log_raw_ws("RECV", current_tab_id or "unknown", raw_msg)
            data = json.loads(raw_msg)
            event = data.get("event")

            if event == "tab_connected":
                current_tab_id = data.get("tabId")
                if current_tab_id:
                    session = state.tabs.setdefault(current_tab_id, TabSession(tab_id=current_tab_id))
                    session.writer = writer
                    session.title = data.get("title", "Chat")
                    session.prompt_text = data.get("promptText", "")
                    session.button_label = data.get("buttonLabel", "Run")
                    session.last_seen = datetime.now()

                    raw_turns = data.get("turns", [])
                    session.merge_turns(raw_turns)

                    handle_preference_vote(session, data.get("preferenceVote"), writer)
                    check_and_dispatch_settled_turns(session, writer)

                    tab_tag = escape(f"[{current_tab_id}]")
                    state.add_log(f"🟢 [green]Chrome tab connected: {tab_tag} ({escape(session.title)}) - {len(session.turns)} turns[/green]")
                    render_event.set()

            elif event == "tab_chat_update":
                tab_id = data.get("tabId") or current_tab_id
                if not tab_id:
                    continue
                session = state.tabs.setdefault(tab_id, TabSession(tab_id=tab_id))
                session.writer = writer
                if "isPrinting" in data:
                    session.is_printing = data.get("isPrinting", False)
                if "buttonLabel" in data:
                    session.button_label = data.get("buttonLabel", "Run")
                if "promptText" in data:
                    session.prompt_text = data.get("promptText", "")
                session.last_seen = datetime.now()

                raw_turns = data.get("turns")
                if raw_turns is not None:
                    session.merge_turns(raw_turns)

                if "preferenceVote" in data:
                    handle_preference_vote(session, data.get("preferenceVote"), writer)

                check_and_dispatch_settled_turns(session, writer)

                if not state.user_manually_selected and session.turns:
                    cur_sel = state.get_selected_tab()
                    if not cur_sel or not cur_sel.turns:
                        try:
                            state.selected_tab_idx = list(state.tabs.keys()).index(tab_id)
                        except ValueError:
                            pass

                render_event.set()

            elif event == "export_chat_json":
                tab_id = data.get("tabId") or current_tab_id or "chat"
                export_data = data.get("exportJson")
                if export_data:
                    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
                    ts_str = datetime.now().strftime("%Y%m%d_%H%M%S")
                    out_path = EXPORTS_DIR / f"{tab_id}_{ts_str}.json"
                    out_path.write_text(json.dumps(export_data, indent=2), encoding="utf-8")
                    tab_tag = escape(f"[{tab_id}]")
                    state.add_log(f"💾 [bold green]Saved chat JSON export for {tab_tag} -> {out_path.name}[/bold green]")
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

    except Exception:
        pass
    finally:
        if current_tab_id and current_tab_id in state.tabs:
            state.tabs.pop(current_tab_id, None)
            tab_tag = escape(f"[{current_tab_id}]")
            state.add_log(f"⚪ [dim]Chrome tab closed: {tab_tag}[/dim]")
            log_raw_ws("DISCONNECT", current_tab_id, "Client disconnected")
            if state.tabs:
                state.selected_tab_idx = max(0, min(state.selected_tab_idx, len(state.tabs) - 1))
            else:
                state.selected_tab_idx = 0
            render_event.set()
        writer.close()
        await writer.wait_closed()

async def async_main():
    worker_task = asyncio.create_task(batch_queue_worker())
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

def main_cli():
    lock = WatcherLock(LOCK_FILE_PATH)
    if not lock.acquire():
        holder = lock.get_holder_pid() or "unknown"
        console.print(f"[bold red]❌ Another instance is already running! (PID: {holder}, Lock: {LOCK_FILE_PATH})[/bold red]")
        sys.exit(1)
    try:
        asyncio.run(async_main())
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        lock.release()
