import asyncio
import tempfile
from pathlib import Path
import pytest
from gemini_bridge.models import PreferenceOption, PreferenceVote, TabSession, state
from gemini_bridge.orchestrator import (
    CommandBatch,
    apply_user_variant_choice,
    batch_queue_worker,
    execution_queue,
)
from gemini_bridge.parser import ParsedCommand

class MockWriter:
    def __init__(self):
        self.written = []

    def write(self, data):
        self.written.append(data)

    async def drain(self):
        pass

@pytest.mark.asyncio
async def test_apply_user_variant_choice_executes_commands():
    session = TabSession(tab_id="tab_test")
    writer = MockWriter()
    session.writer = writer

    vote = PreferenceVote(
        question="Which response do you prefer?",
        options=[
            PreferenceOption(index=0, side="left", text="Regular chat text without code"),
            PreferenceOption(
                index=1,
                side="right",
                text="Let me run this:\nEXECUTE_NEXT_BASH\n```bash\necho 'from_variant_2'\n```",
            ),
        ],
    )
    session.pending_variant_choice = vote
    session.preference_vote = vote

    apply_user_variant_choice(session, 1)

    assert session.pending_variant_choice is None
    assert session.preference_vote is None
    assert len(session.turns) == 1
    assert "from_variant_2" in session.turns[0].chat_content

    assert not execution_queue.empty()
    batch = await execution_queue.get()
    assert batch.tab_id == "tab_test"
    assert len(batch.commands) == 1
    assert batch.commands[0].lang == "bash"
    assert batch.commands[0].code == "echo 'from_variant_2'"
    execution_queue.task_done()  # <--- Marks task done so join() won't hang

@pytest.mark.asyncio
async def test_batch_worker_aborts_on_failure():
    with tempfile.TemporaryDirectory() as tmpdir:
        tab_id = "tab_worker_test"
        session = TabSession(tab_id=tab_id, cwd=tmpdir)
        state.tabs[tab_id] = session
        writer = MockWriter()

        worker_task = asyncio.create_task(batch_queue_worker())

        # 1. Invalid CD (fails)
        # 2. WRITE_NEXT (must NOT run because 1 failed)
        commands = [
            ParsedCommand(
                lang="cd", timeout="5s", code="/nonexistent_path_xyz_999", raw_trigger="CD"
            ),
            ParsedCommand(
                lang="write_next",
                timeout="5s",
                code="test",
                raw_trigger="WRITE_NEXT",
                path="should_not_exist.txt",
                overwrite=False,
            ),
        ]

        await execution_queue.put(CommandBatch(tab_id, writer, commands))
        await asyncio.wait_for(execution_queue.join(), timeout=5.0)

        worker_task.cancel()
        try:
            await worker_task
        except asyncio.CancelledError:
            pass

        assert not (Path(tmpdir) / "should_not_exist.txt").exists()
        assert len(writer.written) > 0
