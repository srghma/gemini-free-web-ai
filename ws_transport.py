import asyncio
from datetime import datetime
import fcntl
import os
from pathlib import Path
import struct
import sys
from rich.console import Console
from rich.markup import escape
from models import state

HOST = "127.0.0.1"
PORT = 8765
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
LOCK_FILE_PATH = Path("/tmp/gemini_bridge_daemon.lock")
LOG_FILE_PATH = Path.home() / "projects" / "gemini-free-web-ai" / "bridge_execution.log"

console = Console()

def acquire_singleton_lock() -> int:
    lock_fd = os.open(LOCK_FILE_PATH, os.O_CREAT | os.O_RDWR, 0o666)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.ftruncate(lock_fd, 0)
        os.write(lock_fd, f"{os.getpid()}\n".encode())
        return lock_fd
    except BlockingIOError:
        console.print(f"[bold red]❌ Another instance is already running! (Lock: {LOCK_FILE_PATH})[/bold red]")
        sys.exit(1)

def log_to_file(entry: str):
    try:
        LOG_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {entry}\n")
    except Exception as e:
        state.add_log(f"[red]Log write error: {escape(str(e))}[/red]")

def make_ws_frame(message: str, opcode: int = 0x81) -> bytes:
    data = message.encode("utf-8")
    length = len(data)
    frame = bytearray([opcode])
    if length <= 125:
        frame.append(length)
    elif length <= 65535:
        frame.append(126)
        frame.extend(struct.pack("!H", length))
    else:
        frame.append(127)
        frame.extend(struct.pack("!Q", length))
    frame.extend(data)
    return bytes(frame)

async def read_ws_frame(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> str | None:
    try:
        header = await reader.readexactly(2)
    except (asyncio.IncompleteReadError, ConnectionResetError):
        return None

    b1, b2 = header
    opcode = b1 & 0x0F
    if opcode == 0x8:
        return None
    if opcode == 0x9:
        writer.write(make_ws_frame("", opcode=0x8A))
        await writer.drain()
        return ""

    length = b2 & 0x7F
    if length == 126:
        ext = await reader.readexactly(2)
        length = struct.unpack("!H", ext)[0]
    elif length == 127:
        ext = await reader.readexactly(8)
        length = struct.unpack("!Q", ext)[0]

    mask = await reader.readexactly(4)
    payload = await reader.readexactly(length)
    return bytearray(b ^ mask[i % 4] for i, b in enumerate(payload)).decode("utf-8")
