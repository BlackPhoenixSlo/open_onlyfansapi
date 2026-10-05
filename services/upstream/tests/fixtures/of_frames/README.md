OF socket frames for `tests/test_events.py`. These are **shape-based reconstructions**, not captures:
they follow the keys `of_ws.py` documents (`api2_chat_message`, `post_expire`, the counter and
`connected` frames) with every value invented (account 100001, fan 200002, `.invalid` urls).
Replace them with redacted real captures once owner question Q1 is answered.

Unverified: the `messages.*` payload is OF's message object as it arrives. The reference product's
examples carry a full `fromUser` (received) and `toUser` (sent); whether OF's frame carries more than
`fromUser.id`, or `toUser` at all, is unknown, so these frames omit them. `../payloads/` holds the
reference key structure.

`chat_message_delete.json` and `system_notifications.json` (2026-10-05) follow the key structure of a 3-day socket
capture (`docs/spec/plan-v6-ws-events.md`), with every value invented. On that subscriber-side account a received
`api2_chat_message` carried the reference's full 42-key `fromUser`; creator-side frames are unverified, and the two
message frames here keep the older 2-key `fromUser`.
