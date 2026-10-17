import asyncio
import pytest
from gemini_bridge.models import PreferenceOption, PreferenceVote, TabSession, state
from gemini_bridge.orchestrator import apply_user_variant_choice, execution_queue

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
            PreferenceOption(index=1, side="right", text="Let me run this:\nEXECUTE_NEXT_BASH\n```bash\necho 'from_variant_2'\n```"),
        ]
    )
    session.pending_variant_choice = vote
    session.preference_vote = vote

    # Select variant 1 (right)
    apply_user_variant_choice(session, 1)

    assert session.pending_variant_choice is None
    assert session.preference_vote is None
    assert len(session.turns) == 1
    assert "from_variant_2" in session.turns[0].chat_content

    # Verify a command batch was queued for execution
    assert not execution_queue.empty()
    batch = await execution_queue.get()
    assert batch.tab_id == "tab_test"
    assert len(batch.commands) == 1
    assert batch.commands[0].lang == "bash"
    assert batch.commands[0].code == "echo 'from_variant_2'"
