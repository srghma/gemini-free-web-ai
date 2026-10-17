from gemini_bridge.models import TabSession

def test_merge_turns():
    session = TabSession(tab_id="tab_1")
    raw = [
        {"id": "t1", "type": "user", "userContent": "run tests"},
        {"id": "t2", "type": "ai_chat", "chatContent": "running", "codeBlocks": [{"lang": "bash", "code": "ls"}]},
    ]
    session.merge_turns(raw)
    assert len(session.turns) == 2
    assert session.turns[0].user_content == "run tests"
    assert session.turns[1].code_blocks[0].code == "ls"

    # Streaming update keeps previous content if omitted
    update = [{"id": "t2", "type": "ai_chat", "status": "completed"}]
    session.merge_turns(update)
    assert len(session.turns) == 2
    assert session.turns[1].status == "completed"
    assert session.turns[1].code_blocks[0].code == "ls"
