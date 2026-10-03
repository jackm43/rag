from unittest.mock import AsyncMock

import pytest
from conftest import FakeResponse

from ragbot.ai import Attribution
from ragbot.conversation import ChatJob, build_conversation

BOT = "123456789012345678"
USER = "123456789012345679"
CHANNEL = "123456789012345681"


def message(number, text, author=USER, reply=None, **extra):
    result = {
        "id": str(123456789012345700 + number),
        "channel_id": CHANNEL,
        "guild_id": "457689460096630794",
        "author": {
            "id": author,
            "username": "ragbot" if author == BOT else "tester",
            "bot": author == BOT,
        },
        "content": text,
        **extra,
    }
    if reply:
        result["message_reference"] = {"message_id": reply["id"], "channel_id": reply["channel_id"]}
    return result


async def test_pingless_reply_preserves_question_answer_and_links_reply_without_ping(app):
    question = message(1, "is this a good idea?\nexplain why")
    answer = message(2, "yes, because it saves time", BOT, question)
    incoming = message(3, "what about the cost?", reply=answer, referenced_message=answer)
    app.discord.message = AsyncMock(return_value=question)
    await app.handle_message(incoming, BOT)
    _, payload, _ = app.env.AI.run.await_args.args
    assert payload["messages"][1:] == [
        {"role": "user", "content": "tester: is this a good idea?\nexplain why"},
        {"role": "assistant", "content": "yes, because it saves time"},
        {"role": "user", "content": "tester: what about the cost?"},
    ]
    app.discord.message.assert_awaited_once_with(CHANNEL, question["id"])
    sent = app.transport.writes()[-1]
    assert sent["message_reference"] == {"message_id": incoming["id"], "fail_if_not_exists": False}
    assert sent["allowed_mentions"] == {"parse": [], "replied_user": False}


@pytest.mark.parametrize("author,called", [(BOT, True), (USER, False)])
async def test_reply_without_embedded_message_checks_author_before_responding(app, author, called):
    parent = message(1, "previous", author)
    incoming = message(2, "why?", reply=parent)
    app.discord.message = AsyncMock(return_value=parent)
    await app.handle_message(incoming, BOT)
    assert bool(app.env.AI.run.await_count) is called
    app.discord.message.assert_awaited_once()


async def test_reply_chain_is_bounded_and_does_not_follow_cross_channel_reference(app):
    items = [message(i, f"turn {i}") for i in range(6)]
    for i in range(1, 6):
        items[i]["message_reference"] = {"message_id": items[i - 1]["id"]}
    app.discord.message = AsyncMock(side_effect=lambda c, m: next(x for x in items if x["id"] == m))
    job = ChatJob(
        Attribution("channel_reply", USER, "tester", CHANNEL, items[5]["id"]),
        "current",
        BOT,
        reply_message_id=items[4]["id"],
    )
    result = await build_conversation(app, job, 2)
    assert [m["content"] for m in result] == ["tester: turn 3", "tester: turn 4", "tester: current"]
    assert app.discord.message.await_count == 2
    app.discord.message.reset_mock()
    job.reply_channel_id = "another-channel"
    assert len(await build_conversation(app, job, 12)) == 1
    app.discord.message.assert_not_awaited()


async def test_mentions_and_attachments_preserve_meaning_without_claiming_media_access(app):
    target = "123456789012345699"
    incoming = message(
        4,
        f"<@{BOT}> explain this to <@{target}>\nkeep it short",
        mentions=[{"id": target, "username": "friend", "global_name": "Alex"}],
        attachments=[{"id": "1", "filename": "picture.png", "url": "https://example.com/image"}],
    )
    await app.handle_message(incoming, BOT)
    _, payload, _ = app.env.AI.run.await_args.args
    text = payload["messages"][-1]["content"]
    assert "explain this to Alex\nkeep it short" in text
    assert "contents not provided" in text and target not in text


async def test_unavailable_reply_still_answers_explicit_mention(app):
    incoming = message(4, f"<@{BOT}> explain this", reply=message(3, "deleted"))
    app.discord.message = AsyncMock(side_effect=RuntimeError("unavailable"))
    await app.handle_message(incoming, BOT)
    app.env.AI.run.assert_awaited_once()


async def test_rest_reply_with_nested_references_preserves_entire_chain(app):
    question = message(1, "original question")
    answer = message(2, "first answer", BOT, question, referenced_message=question)
    followup = message(3, "follow-up question", reply=answer, referenced_message=answer)
    incoming = message(4, f"<@{BOT}> explain further", reply=followup)
    app.transport.handler = lambda url, options: (
        FakeResponse(followup) if url.endswith(f"/messages/{followup['id']}") else None
    )

    await app.handle_message(incoming, BOT)

    _, payload, _ = app.env.AI.run.await_args.args
    assert payload["messages"][1:] == [
        {"role": "user", "content": "tester: original question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "tester: follow-up question"},
        {"role": "user", "content": "tester: explain further"},
    ]
