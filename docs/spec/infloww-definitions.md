# Infloww metric definitions (public sources)

Written 2026-10-05 from help.infloww.com, no login. Input to step 0 of
[future-client-story-ask.md](future-client-story-ask.md): the diff compares our numbers against these rules.
Wording is paraphrased from help pages; confidence per item. "Unknown" means nothing public exists, so the diff
computes our definition only and marks the Infloww column n/a.

## 1. Reply time

Sources: [Employee Reports](https://help.infloww.com/en/articles/262078-employee-reports),
[Creator Reports](https://help.infloww.com/en/articles/276166-creator-reports),
[Message Dashboard](https://help.infloww.com/en/articles/262061-message-dashboard).

- "Reply time: average time taken to reply to a fan's message. DM only." (Creator Reports)
- Employee Reports has two variants: "Response time (scheduled hours)" over scheduled shifts and "Response time
  (clock hours)" over clocked-in time. Both "exclude unreplied messages".
- Message Dashboard shows reply time per message, over "direct messages sent to online fans, excluding auto-messages
  and mass messages".

Known (high): it is a **mean**, not a median. **Unreplied messages are excluded**, not capped. Only DMs count; mass
and automated messages are excluded. Employee variants are limited to shift or clocked time.

Unknown: whether the timer starts at the first or the last unanswered fan message; any cap or outlier rule; whether
a PPV counts as a reply.

Diff rule: compute our per-turn median (spec §2) and also a mean over replied turns only, DMs only, with both
turn-start variants (first and last unanswered inbound). Report which variant lands closest to Infloww.

## 2. Scripts

Sources: [Scripts](https://help.infloww.com/en/articles/7907823-scripts),
[Getting started with scripts](https://help.infloww.com/en/articles/262042-getting-started-with-scripts),
[Importing scripts from Excel](https://help.infloww.com/en/articles/262073-importing-scripts-from-excel).

- "Pre-written message templates"; grouped into ordered sequences of up to 200; conditional scripts with up to 3
  options. Chatters send one by typing `/keyword` in Messages Pro.
- Per-script stats: times sent, times purchased, total PPV sales, conversion (purchased ÷ sent; the help page has
  the division inverted).
- Each message carries a script flag (Message Dashboard filter "with script / without script").
- Employee "Character count" excludes automated, mass and scripted messages.
- Excel import columns: Script name (64), Text (1000), Notes (246); one sheet per tag (32). No media or price.

Known (high): the stat fields. Low: detection is most likely "sent through the Infloww picker" (inference); an
edited script's status and any attribution window are unknown. Purchase appears to mean the PPV message itself
being unlocked, not a later purchase.

Diff rule: our hash-based script detection (spec §4.4) will find sends Infloww does not flag (sent outside the
picker) and vice versa (edited scripts). Report both sets; "purchased" compares only to the PPV-unlock of the same
message.

## 3. Openers, first messages, reactivation

Unknown. No public metric. Closest: Smart Messages automations (online-fan nudge, expiring/expired, resubscribe,
welcome) with analytics limited to Sent, Purchased, Earnings, Attachments, Price
([Smart Message Analytics](https://help.infloww.com/en/articles/262044-smart-message-analytics)).

Diff rule: n/a. Openers are ours only.

## 4. Chatter attribution

Sources: [Team management](https://help.infloww.com/en/articles/262104-team-management-a-guide-to-managing-employees-in-infloww),
[Employee calculation rules](https://help.infloww.com/en/articles/262080-employee-calculation-rules).

- Each employee has their own login to the Infloww desktop app (which proxies each creator). Sender = whoever sent
  through the app. Messages Pro shows who sent or unsent each message.
- Sales attribution is a setting: **shift schedule** (single employee on shift; not possible with shared shifts),
  **message sender** (employee messaging the fan in that period), **converters** (employee who sent the most recent
  message when the fan pays). Subscriptions, streams and referrals use shift schedule only.
- Messages sent directly on OnlyFans are not addressed.

Known (high): mechanism. Unknown: the converter lookback window; whether an automated or mass message can be the
"most recent message".

Maps to spec §5 question 1: option (b), an export naming the chatter per message, is what the Message Dashboard
export should give.

## 5. Shifts

Sources: [Scheduling shifts](https://help.infloww.com/en/articles/262099-scheduling-shifts),
[Time tracking](https://help.infloww.com/en/articles/300963-time-tracking),
[Time zones for reports](https://help.infloww.com/en/articles/262077-time-zones-for-reports).

- Shift = date/time range, creators, employees, optional weekly repeat; multi-employee shifts are a toggle.
- Time tracking: clock in/out, active on keyboard use, auto clock-out after a configurable idle period (min 1 min).
- Report time zone is a setting; Infloww recommends UTC+0. No handover or notes feature.

Known (high).

## 6. Exports

- **Clocked hours XLSX** (high): `Clocked_Hours_{employee}_{from}_to_{to}.xlsx`, columns Group, Employee, Clocked
  hours, Clock in date/time (UTC+0:00), Clock out date/time (UTC+0:00).
- **Sales Records CSV** (high, [source](https://help.infloww.com/en/articles/529697-sales-records)): Date & time,
  Employee, Creator, Fan, Earnings, Gross revenue, Net revenue, Type, Rule, Assigned by, Status, Action. Type is
  message, tip, subscription, etc. Sales can be reassigned.
- **Message Dashboard export** (medium): up to 100 senders, up to 1 month, minute-level range, emailed link valid
  30 days, data refreshes every 10 min, "matches exactly what you see". Visible fields: sender, sent to, reply time,
  purchase status, message earnings gross/net, type (script), status (sent/withdrawn), price. File columns unknown.
- Creator/Fan report export columns undocumented. Data retained 12 months.

This is the export to ask the client for: **Message Dashboard export, one creator, one past week**, plus the Sales
Records CSV for the same range.

## 7. Automations, bots, welcome messages

Source: Employee Reports. Excluded from chatter stats (high):

- "Direct messages sent: excludes PMM, OFMM, welcome, and automated messages."
- Direct message sales, Direct PPVs sent, Fans chatted, Fans who spent, Avg earnings per fan: same exclusions.
- Priority mass message sales and OF mass message sales are separate columns, PPVs only, not tips.
- Creator report counts manual DMs only.

Other formulas: Golden ratio = Direct PPVs sent ÷ Direct messages sent; Unlock rate = PPVs unlocked ÷ PPVs sent;
Fan CVR = Fans who spent ÷ Fans chatted; Sales per clocked hour = (PPV sales + Tips) ÷ Clocked hours.

Matches spec §2 automation rule and §3 trap "Automated sends count": Infloww already excludes them, so a difference
there is on our side.

## Summary for the step 0 diff

| Item | Diffable? |
|---|---|
| Reply time | Yes, as mean over replied DM turns; turn-start variant unknown |
| Mass/auto exclusions | Yes, same rule both sides |
| Script sent / purchased | Partly; detection differs |
| Openers | No, ours only |
| Chatter per message | Yes, from the Message Dashboard export |
| Sales per fan | Yes, from Sales Records CSV |
| Reply-time cap, converter window, export columns | Unknown |
