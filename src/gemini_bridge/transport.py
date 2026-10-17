import asyncio
from datetime import datetime
import fcntl
import os
from pathlib import Path
import struct
from rich.console import Console
from rich.markup import escape
from .models import state

HOST = "127.0.0.1"
PORT = 8765
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
LOCK_FILE_PATH = Path("/tmp/gemini_bridge_daemon.lock")
LOG_FILE_PATH = Path.home() / "projects" / "gemini-free-web-ai" / "bridge_execution.log"
RAW_LOG_FILE_PATH = Path.home() / "projects" / "gemini-free-web-ai" / "bridge_websocket_raw.log"

console = Console()

class WatcherLock:
    def __init__(self, lock_path: Path):
        self.lock_path = lock_path
        self._file = None

    def acquire(self) -> bool:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        self._file = open(self.lock_path, "a+")
        try:
            fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._file.seek(0)
            self._file.truncate()
            self._file.write(f"{os.getpid()}\n")
            self._file.flush()
            return True
        except (BlockingIOError, OSError):
            return False

    def get_holder_pid(self) -> str | None:
        try:
            if self.lock_path.exists():
                return self.lock_path.read_text(encoding="utf-8").strip() or None
        except Exception:
            pass
        return None

    def release(self):
        if self._file:
            try:
                fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
                self._file.close()
            except Exception:
                pass
            self._file = None

def log_to_file(entry: str):
    try:
        LOG_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {entry}\n")
            f.flush()
    except Exception as e:
        state.add_log(f"[red]Log write error: {escape(str(e))}[/red]")

def log_raw_ws(direction: str, tab_id: str, message: str):
    try:
        RAW_LOG_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        with open(RAW_LOG_FILE_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] [{direction}] [{tab_id or 'unknown'}] {message}\n")
            f.flush()
    except Exception:
        pass

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
