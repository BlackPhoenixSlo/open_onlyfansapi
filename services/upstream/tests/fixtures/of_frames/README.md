OF socket frames for `tests/test_events.py`. These are **shape-based reconstructions**, not captures:
they follow the keys `of_ws.py` documents (`api2_chat_message`, `post_expire`, the counter and
`connected` frames) with every value invented (account 100001, fan 200002, `.invalid` urls).
Replace them with redacted real captures once owner question Q1 is answered.

Unverified: `message.sent`'s `fanId` is read from `toUser.id`; whether OF's frame for your own
message carries `toUser` is unknown, so `api2_chat_message.sent.json` omits it and `fanId` is null.
