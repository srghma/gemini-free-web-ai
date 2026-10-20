import asyncio
import io
import struct
import pytest
from gemini_bridge.transport import make_ws_frame, read_ws_frame

@pytest.mark.asyncio
async def test_read_fragmented_ws_frames():
    # Frame 1: opcode=1 (text), fin=0, payload="hello "
    # Frame 2: opcode=0 (continuation), fin=1, payload="world!"
    mask = b"1234"
    def make_frame(opcode, fin, text):
        data = text.encode("utf-8")
        b1 = (0x80 if fin else 0) | opcode
        b2 = 0x80 | len(data)  # masked
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return bytes([b1, b2]) + mask + payload

    raw_bytes = make_frame(0x1, False, "hello ") + make_frame(0x0, True, "world!")

    reader = asyncio.StreamReader()
    reader.feed_data(raw_bytes)
    reader.feed_eof()

    class DummyWriter:
        def write(self, data): pass
        async def drain(self): pass

    assembled = await read_ws_frame(reader, DummyWriter())
    assert assembled == "hello world!"
