import {
    InteractionResponseFlags,
    InteractionResponseType,
} from "discord-interactions";

import type { CommandModule } from "./types";

const helpMessage = [
    "Here’s what PledgeBot can do:",
    "",
    "**User commands**",
    "• `/sell` — Publish a sell listing with price, stock, and optional image.",
    "• `/buy` — Publish a buy order with the item, price, and optional quantity.",
    "",
    "**Admin commands**",
    "• `/trade cancel` — Cancel a trade by ID and share the reason.",
    "• `/trade history` — Review your trade history with optional page and status filters.",
    "• `/tradeconfig channel` — Set the trade announcement channel and type (forum or text).",
    "• `/tradeconfig forumtags` — Add, remove, or list forum tags for buy and sell announcements.",
    "• `/tradeconfig roles` — Manage the roles required to run trade commands.",
    "",
].join("\n");

const helpCommand: CommandModule = {
    data: {
        name: "help",
        description: "Show a summary of available commands.",
    },
    async execute() {
        return {
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
                content: helpMessage,
                flags: InteractionResponseFlags.EPHEMERAL,
            },
        };
    },
};

export default helpCommand;
