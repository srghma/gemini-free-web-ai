#!/usr/bin/env python3
import asyncio
import base64
import hashlib
import json
import os
import subprocess
import struct
import tempfile
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8765
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

def execute_code(lang: str, code: str) -> tuple[str, str, int]:
    """Execute code in user's environment (NixOS / zsh / bun / python)."""
    ext_map = {"python": ".py", "bash": ".sh", "bun": ".ts"}
    suffix = ext_map.get(lang, ".sh")

    with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False) as f:
        f.write(code)
        tmp_path = f.name

    try:
        if lang == "python":
            cmd = ["python3", tmp_path]
        elif lang == "bun":
            cmd = ["bun", "run", tmp_path]
        else:
            cmd = ["zsh", tmp_path]

        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
            cwd=str(Path.home() / "projects") if (Path.home() / "projects").exists() else str(Path.home())
        )
        return proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired:
        return "", "Execution timed out after 120 seconds.", 124
    except Exception as e:
        return "", str(e), 1
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

def make_ws_frame(message: str) -> bytes:
    """Pack string into an RFC 6455 unmasked server-to-client text frame."""
    data = message.encode("utf-8")
    length = len(data)
    frame = bytearray([0x81])  # FIN + Text Opcode
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

async def read_ws_frame(reader: asyncio.StreamReader) -> str | None:
    """Read and unmask a client-to-server WebSocket frame."""
    header = await reader.read(2)
    if len(header) < 2:
        return None
    b1, b2 = header
    opcode = b1 & 0x0F
    if opcode == 0x8:  # Close frame
        return None

    length = b2 & 0x7F
    if length == 126:
        ext = await reader.read(2)
        length = struct.unpack("!H", ext)[0]
    elif length == 127:
        ext = await reader.read(8)
        length = struct.unpack("!Q", ext)[0]

    mask = await reader.read(4)
    payload = await reader.readexactly(length)
    unmasked = bytearray(b ^ mask[i % 4] for i, b in enumerate(payload))
    return unmasked.decode("utf-8")

async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    # 1. Perform HTTP -> WebSocket Handshake
    headers = b""
    while b"\r\n\r\n" not in headers:
        line = await reader.readline()
        if not line:
            return
        headers += line

    headers_str = headers.decode("utf-8", errors="ignore")
    ws_key = None
    for line in headers_str.split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            ws_key = line.split(":", 1)[1].strip()

    if not ws_key:
        writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        await writer.drain()
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
    print("[Server] Extension connected via WebSocket.")

    # 2. Main execution loop
    try:
        while True:
            raw_msg = await read_ws_frame(reader)
            if raw_msg is None:
                break

            try:
                data = json.loads(raw_msg)
                code = data.get("code", "")
                lang = data.get("type", "python")
                tab_id = data.get("tabId")

                print(f"\n[EXEC] Running {lang.upper()} (tabId: {tab_id})...")
                stdout, stderr, code_res = execute_code(lang, code)

                response = {
                    "tabId": tab_id,
                    "type": lang,
                    "output": stdout,
                    "error": stderr,
                    "exitCode": code_res
                }
                writer.write(make_ws_frame(json.dumps(response)))
                await writer.drain()
                print(f"[EXEC] Sent output back to tab {tab_id}.")
            except json.JSONDecodeError:
                pass
    except (asyncio.IncompleteReadError, ConnectionResetError):
        pass
    finally:
        writer.close()
        await writer.wait_closed()
        print("[Server] Extension disconnected.")

async def main():
    server = await asyncio.start_server(handle_client, HOST, PORT)
    print(f"[*] Gemini AI Bridge daemon running at ws://{HOST}:{PORT}")
    async with server:
        await server.serve_forever()

if __name__ == "__main__":
    asyncio.run(main())
