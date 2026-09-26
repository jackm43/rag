from ragbot.policy import finalize_ai_reply, suppress_url_embeds, truncate_discord


def test_mentions_and_embeds():
    assert (
        finalize_ai_reply("Ragbot: Hello <@123456789012345678> @everyone https://example.org.")
        == "Hello everyone <https://example.org>."
    )
    assert (
        suppress_url_embeds("`https://example.org` <https://example.org> (https://example.org)")
        == "`https://example.org` <https://example.org> (<https://example.org>)"
    )


def test_empty_and_emoji_limit():
    assert finalize_ai_reply("<@123456789012345678>") == "I could not generate a response."
    assert truncate_discord("😀" * 1000, 1900) == "😀" * 950
