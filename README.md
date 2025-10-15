# Commands

## General

- `/help`

## Admin

- `/tradeconfig channel channel:<#channel> type:<forum|text>`
- `/tradeconfig forumtags sell tag_id?:<string>`
- `/tradeconfig forumtags buy tag_id?:<string>`
- `/tradeconfig roles add role:<@role>`
- `/tradeconfig roles remove role:<@role>`
- `/tradeconfig roles list`
- `/trade history page?:<number> status?:<open|matched|escrow|complete|cancelled|expired>`
- `/trade cancel trade_id:<id> reason:<text>`

### Forum trade channels

When the trade channel is configured as a forum, you can optionally set Discord forum tag IDs that
will be applied to new announcements:

- `/tradeconfig forumtags sell tag_id:<string>` to set the tag for sell offers (leave `tag_id` empty to clear).
- `/tradeconfig forumtags buy tag_id:<string>` to set the tag for buy orders (leave `tag_id` empty to clear).

If no tag is configured, announcements will post without any forum tags.

## User

- `/sell title:<text> auec:<integer> stock?:<integer=1> image?:<attachment>`
- `/buy item:<text> price:<integer> amount?:<integer> attachment?:<attachment>`
- `/trade history page?:<number> status?:<open|matched|escrow|complete|cancelled|expired>`
- `/trade cancel trade_id:<id> reason:<text>`
