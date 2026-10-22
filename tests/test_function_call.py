import asyncio
import json
import pytest
from gemini_bridge.models import TabSession
from gemini_bridge.orchestrator import handle_function_call

class DummyWriter:
    def __init__(self):
        self.written = []

    def write(self, data):
        self.written.append(data)

    async def drain(self):
        pass

@pytest.mark.asyncio
async def test_handle_bash_function_call():
    session = TabSession(tab_id="tab_test")
    writer = DummyWriter()
    args = {"commands": ["echo 'hello from tool'"]}

    await handle_function_call(session, writer, "execute_bash", args, call_id="call_1")

    assert len(writer.written) == 1
    # Check that a submit_function_response frame was sent
    assert b"submit_function_response" in writer.written[0]
    assert b"hello from tool" in writer.written[0]

@pytest.mark.asyncio
async def test_handle_cd_function_call(tmp_path):
    session = TabSession(tab_id="tab_test")
    writer = DummyWriter()
    args = {"path": str(tmp_path)}

    await handle_function_call(session, writer, "change_directory", args, call_id="call_2")

    assert session.cwd == str(tmp_path.resolve())
    assert b"submit_function_response" in writer.written[0]
