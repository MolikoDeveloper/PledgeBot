# Commands

## General

- `/help`

## Admin

- `/tradeconfig channel channel:<#channel> type:<forum|text>`
- `/tradeconfig forumtags sell-add tag_id:<string>`
- `/tradeconfig forumtags sell-remove tag_id:<string>`
- `/tradeconfig forumtags sell-list`
- `/tradeconfig forumtags buy-add tag_id:<string>`
- `/tradeconfig forumtags buy-remove tag_id:<string>`
- `/tradeconfig forumtags buy-list`
- `/tradeconfig roles add role:<@role>`
- `/tradeconfig roles remove role:<@role>`
- `/tradeconfig roles list`
- `/trade history page?:<number> status?:<open|matched|escrow|complete|cancelled|expired>`
- `/trade cancel trade_id:<id> reason:<text>`

### Forum trade channels

When the trade channel is configured as a forum, you can optionally set Discord forum tag IDs that
will be applied to new announcements. Multiple tags can be configured per trade type:

- `/tradeconfig forumtags sell-add tag_id:<string>` to add a forum tag for sell offers.
- `/tradeconfig forumtags sell-remove tag_id:<string>` to remove a specific forum tag from sell offers.
- `/tradeconfig forumtags sell-list` to review all forum tags configured for sell offers.
- `/tradeconfig forumtags buy-add tag_id:<string>` to add a forum tag for buy orders.
- `/tradeconfig forumtags buy-remove tag_id:<string>` to remove a specific forum tag from buy orders.
- `/tradeconfig forumtags buy-list` to review all forum tags configured for buy orders.

If no tags are configured, announcements will post without any forum tags.

#### Manual verification

To confirm multi-tag behaviour:

1. Configure a forum trade channel and add at least two sell and buy forum tag IDs via `/tradeconfig forumtags`.
2. Run `/sell create` and `/buy` commands to publish announcements.
3. Open the resulting forum threads and verify that all configured tags appear on each new thread.

If no tags are configured, the announcements should still publish without any applied tags.

## User

- `/sell title:<text> auec:<integer> stock?:<integer=1> image?:<attachment>`
- `/buy item:<text> price:<integer> amount?:<integer> attachment?:<attachment>`
- `/trade history page?:<number> status?:<open|matched|escrow|complete|cancelled|expired>`
- `/trade cancel trade_id:<id> reason:<text>`
