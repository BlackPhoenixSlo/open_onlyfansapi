OF socket frames for `tests/test_events.py`. These are **shape-based reconstructions**, not captures:
they follow the keys `of_ws.py` documents (`api2_chat_message`, `post_expire`, the counter and
`connected` frames) with every value invented (account 100001, fan 200002, `.invalid` urls).
Replace them with redacted real captures once owner question Q1 is answered.

Unverified: the `messages.*` payload is OF's message object as it arrives. The reference product's
examples carry a full `fromUser` (received) and `toUser` (sent); whether OF's frame carries more than
`fromUser.id`, or `toUser` at all, is unknown, so these frames omit them. `../payloads/` holds the
reference key structure.
