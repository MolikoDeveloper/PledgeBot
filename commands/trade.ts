import {
    InteractionResponseFlags,
    InteractionResponseType,
    InteractionType,
} from "discord-interactions";

import {
    trade_status,
    getTradeById,
    getTradeConfig,
    getUserById,
    listTrades,
    updateTradeAnnouncementMetadata,
    updateTradeStatus,
} from "../src/database";
import { ensureAdminAccess } from "../src/permissions";
import { ApplicationCommandOptionType } from "./types";
import type {
    ChatInputCommandInteraction,
    CommandData,
    CommandExecuteContext,
    CommandModule,
    CommandResponse,
    InteractionDataOption,
} from "./types";
import {
    buildAnnouncementUrl,
    buildSellThreadName,
    buildTradeAnnouncementContent,
    buildTradeEmbed,
    patchTradeAnnouncement,
    resolveForumThreadId,
    resolveUserTag,
    shouldArchiveSellThread,
    updateForumThread,
} from "./trade-utils";

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

async function handleCancel(params: {
    interaction: ChatInputCommandInteraction;
    lookup: OptionLookup;
    config: CommandExecuteContext["config"];
}): Promise<CommandResponse> {
    const { interaction, lookup, config } = params;

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

    const updated = await updateTradeStatus({ tradeId, status: "cancelled", reason });
    if (!updated) {
        return buildReply("Failed to update the trade status. Try again in a moment.");
    }

    let metadataError: Error | null = null;
    try {
        await updateTradeAnnouncementMetadata({
            tradeId: updated.id,
            doneOneButtonId: null,
            doneAllButtonId: null,
            cancelButtonId: null,
        });
    } catch (error) {
        metadataError = error instanceof Error
            ? error
            : new Error("Unknown error while clearing control metadata.");
        console.error(`Failed to clear trade control metadata for trade #${updated.id}`, error);
    }

    const storedUser = await getUserById(updated.user_id);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        fallbackId: updated.user_id,
    });

    const embed = buildTradeEmbed({ trade: updated, userTag, statusLabel: "Cancelled" });
    const announcementContent = buildTradeAnnouncementContent({
        trade: updated,
        userId: updated.user_id,
    });
    const announcementUrl = buildAnnouncementUrl({
        guildId: interaction.guild_id,
        channelId: updated.announcement_channel_id,
        messageId: updated.announcement_message_id,
    });

    let announcementPatchError: Error | null = null;
    let missingAnnouncementMetadata = false;
    let threadUpdateError: Error | null = null;

    if (!config.allowOffline) {
        if (updated.announcement_channel_id && updated.announcement_message_id) {
            try {
                await patchTradeAnnouncement({
                    token: config.botToken,
                    channelId: updated.announcement_channel_id,
                    messageId: updated.announcement_message_id,
                    embed,
                    content: announcementContent,
                    components: [],
                });
            } catch (error) {
                announcementPatchError =
                    error instanceof Error ? error : new Error("Unknown announcement update failure.");
                console.error(`Failed to patch trade announcement for trade #${updated.id}`, error);
            }
        } else {
            missingAnnouncementMetadata = true;
        }

        const tradeConfig = await getTradeConfig(interaction.guild_id);
        const threadId = resolveForumThreadId({
            announcementChannelId: updated.announcement_channel_id,
            tradeChannelId: tradeConfig.tradeChannelId,
            tradeChannelType: tradeConfig.tradeChannelType,
        });

        if (threadId) {
            try {
                await updateForumThread({
                    token: config.botToken,
                    threadId,
                    name: buildSellThreadName(updated),
                    ...(shouldArchiveSellThread(updated.status) ? { archived: true, locked: true } : {}),
                });
            } catch (error) {
                threadUpdateError =
                    error instanceof Error ? error : new Error("Unknown forum thread update failure.");
                console.error(`Failed to update forum thread for trade #${updated.id}`, error);
            }
        }
    }

    const responseLines = [
        `Trade #${updated.id} has been cancelled.`,
        announcementUrl ? `Announcement: ${announcementUrl}` : undefined,
        config.allowOffline ? "Offline mode: announcement was not updated." : undefined,
        missingAnnouncementMetadata ? "No stored announcement message to update." : undefined,
        announcementPatchError ? "Warning: Failed to update the trade announcement." : undefined,
        metadataError ? "Warning: Failed to update stored control metadata." : undefined,
        threadUpdateError ? "Warning: Failed to update the trade forum thread." : undefined,
    ].filter(Boolean);

    return buildReply(responseLines.join("\n"));
}

const tradeCommand: CommandModule = {
    data,
    requiresAdmin: true,
    async execute({ interaction, config }) {
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
            return handleCancel({ interaction, lookup, config });
        }

        return buildReply("Unsupported subcommand.");
    },
};

export default tradeCommand;
