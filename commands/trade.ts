import {
    InteractionResponseFlags,
    InteractionResponseType,
    InteractionType,
} from "discord-interactions";

import {
    trade_status,
    getTradeById,
    listTrades,
    updateTradeStatus,
} from "../src/database";
import { ensureAdminAccess } from "../src/permissions";
import { ApplicationCommandOptionType } from "./types";
import type {
    ChatInputCommandInteraction,
    CommandData,
    CommandModule,
    CommandResponse,
    InteractionDataOption,
} from "./types";

const statusChoices = trade_status.map((value) => ({ name: value, value }));

const data: CommandData = {
    name: "trade",
    description: "Manage trade history.",
    dm_permission: false,
    options: [
        {
            type: ApplicationCommandOptionType.SUB_COMMAND,
            name: "history",
            description: "Show trade history with optional filters.",
            options: [
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "page",
                    description: "Page number (default: 1)",
                    min_value: 1,
                },
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "status",
                    description: "Filter by trade status",
                    choices: statusChoices,
                },
            ],
        },
        {
            type: ApplicationCommandOptionType.SUB_COMMAND,
            name: "cancel",
            description: "Cancel an existing trade.",
            options: [
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "trade_id",
                    description: "ID of the trade to cancel",
                    required: true,
                    min_value: 1,
                },
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "reason",
                    description: "Reason for cancelling the trade",
                    required: true,
                },
            ],
        },
    ],
};

type SubcommandName = "history" | "cancel";

type OptionLookup = Record<string, InteractionDataOption | undefined>;

function buildReply(content: string): CommandResponse {
    return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
            content,
            flags: InteractionResponseFlags.EPHEMERAL,
        },
    };
}

function extractSubcommandOptions(interaction: ChatInputCommandInteraction): {
    name: SubcommandName | null;
    options: InteractionDataOption[];
} {
    if (!interaction.data.options || interaction.data.options.length === 0) {
        return { name: null, options: [] };
    }

    const [first] = interaction.data.options;
    if (!first || first.type !== ApplicationCommandOptionType.SUB_COMMAND) {
        return { name: null, options: [] };
    }

    return {
        name: first.name as SubcommandName,
        options: first.options ?? [],
    };
}

function normalizeOptions(options: InteractionDataOption[]): OptionLookup {
    return options.reduce<OptionLookup>((acc, option) => {
        acc[option.name] = option;
        return acc;
    }, {});
}

function getIntegerOption(lookup: OptionLookup, name: string): number | null {
    const option = lookup[name];
    if (!option || typeof option.value !== "number") {
        return null;
    }
    return option.value;
}

function getStringOption(lookup: OptionLookup, name: string): string | null {
    const option = lookup[name];
    if (!option || typeof option.value !== "string") {
        return null;
    }
    return option.value;
}

async function handleHistory(interaction: ChatInputCommandInteraction, lookup: OptionLookup) {
    if (!interaction.guild_id) {
        return buildReply("This command can only be used in a guild.");
    }

    const page = getIntegerOption(lookup, "page") ?? 1;
    const statusValue = getStringOption(lookup, "status") ?? undefined;

    const trades = await listTrades({
        guildId: interaction.guild_id,
        page,
        status: statusValue as (typeof trade_status)[number] | undefined,
    });

    if (trades.length === 0) {
        return buildReply("No trades found for the provided filters.");
    }

    const lines = trades.map((trade) => {
        const reasonSuffix = trade.reason ? ` — Reason: ${trade.reason}` : "";
        return `#${trade.id} · ${trade.title} · ${trade.auec} aUEC · Stock ${trade.stock} · Status: ${trade.status}${reasonSuffix}`;
    });

    return buildReply(lines.join("\n"));
}

async function handleCancel(interaction: ChatInputCommandInteraction, lookup: OptionLookup) {
    if (!interaction.guild_id) {
        return buildReply("This command can only be used in a guild.");
    }

    const tradeId = getIntegerOption(lookup, "trade_id");
    const reason = getStringOption(lookup, "reason");

    if (tradeId === null || reason === null) {
        return buildReply("Trade ID and reason are required.");
    }

    const existing = await getTradeById(tradeId);
    if (!existing || existing.guild_id !== interaction.guild_id) {
        return buildReply(`Trade #${tradeId} does not exist for this guild.`);
    }

    if (existing.status === "cancelled") {
        return buildReply(`Trade #${tradeId} is already cancelled.`);
    }

    await updateTradeStatus({ tradeId, status: "cancelled", reason });
    return buildReply(`Trade #${tradeId} has been cancelled.`);
}

const tradeCommand: CommandModule = {
    data,
    requiresAdmin: true,
    async execute({ interaction }) {
        if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
            return buildReply("Unsupported interaction type.");
        }

        const adminCheck = await ensureAdminAccess(interaction, { allowModeratorRoles: true });
        if (!adminCheck.ok) {
            return adminCheck.response;
        }

        const { name, options } = extractSubcommandOptions(interaction);
        const lookup = normalizeOptions(options);

        if (name === "history") {
            return handleHistory(interaction, lookup);
        }

        if (name === "cancel") {
            return handleCancel(interaction, lookup);
        }

        return buildReply("Unsupported subcommand.");
    },
};

export default tradeCommand;
