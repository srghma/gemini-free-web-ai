#!/usr/bin/env python3
import asyncio
import base64
import hashlib
import json
import struct

from executor import execute_task, parse_timeout

HOST = "127.0.0.1"
PORT = 8765
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# --- WebSocket Framing & Transport ---

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

    if opcode == 0x8:  # Close frame
        return None
    if opcode == 0x9:  # Ping -> reply Pong
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


# --- Central Execution Queue (Serial Execution) ---

execution_queue: asyncio.Queue[tuple[asyncio.StreamWriter, dict]] = asyncio.Queue()


async def queue_worker():
    while True:
        writer, task = await execution_queue.get()
        try:
            lang = task.get("type", "python")
            code = task.get("code", "")
            timeout = parse_timeout(task.get("timeout"))

            print(f"\n[QUEUE] Executing {lang.upper()} (timeout: {timeout}s)...")

            # Notify client that command started
            try:
                writer.write(make_ws_frame(json.dumps({"status": "running", "type": lang, "timeout": f"{timeout}s"})))
                await writer.drain()
            except Exception:
                pass

            res = await execute_task(lang, code, timeout)

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
                print(f"[QUEUE] Done {lang.upper()} (Status: {response['status']}, Exit: {res.exit_code})")
            except Exception as e:
                print(f"[QUEUE] Client disconnected before receiving reply: {e}")

        except Exception as err:
            print(f"[QUEUE] Worker error: {err}")
        finally:
            execution_queue.task_done()


# --- Server Lifecycle ---

async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    headers = b""
    while b"\r\n\r\n" not in headers:
        line = await reader.readline()
        if not line:
            return
        headers += line

    headers_str = headers.decode("utf-8", errors="ignore")
    ws_key = next(
        (l.split(":", 1)[1].strip() for l in headers_str.split("\r\n") if l.lower().startswith("sec-websocket-key:")),
        None,
    )

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
    print("[Server] Tab connected via WebSocket.")

    try:
        while True:
            raw_msg = await read_ws_frame(reader, writer)
            if raw_msg is None:
                break
            if not raw_msg:
                continue

            data = json.loads(raw_msg)
            await execution_queue.put((writer, data))
            print(f"[Server] Enqueued {data.get('type')} (Queue depth: {execution_queue.qsize()})")
    except (asyncio.IncompleteReadError, ConnectionResetError, json.JSONDecodeError):
        pass
    finally:
        writer.close()
        await writer.wait_closed()
        print("[Server] Tab disconnected.")


async def main():
    asyncio.create_task(queue_worker())
    server = await asyncio.start_server(handle_client, HOST, PORT)
    print(f"[*] Gemini AI Bridge daemon running at ws://{HOST}:{PORT}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
