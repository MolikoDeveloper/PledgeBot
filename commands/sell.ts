import {
    InteractionResponseFlags,
    InteractionResponseType,
} from "discord-interactions";

import {
    createTrade,
    getTradeById,
    getTradeConfig,
    getUserById,
    listTradesByUser,
    recordGuild,
    recordUser,
    updateTradeAnnouncementMetadata,
    updateTradeStatus,
    type TradeStatus,
    type TradeRecord,
    type UserRecord,
} from "../src/database";
import {
    ApplicationCommandOptionType,
    ButtonStyle,
    ComponentType,
    type CommandData,
    type CommandExecuteContext,
    type CommandModule,
    type CommandResponse,
    type InteractionAttachment,
    type InteractionDataOption,
    type InteractionUser,
    type MessageComponent,
} from "./types";

const numberFormatter = new Intl.NumberFormat("en-US");

const commandData: CommandData = {
    name: "sell",
    description: "Manage trade offers.",
    dm_permission: false,
    options: [
        {
            type: ApplicationCommandOptionType.SUB_COMMAND,
            name: "create",
            description: "Create a new trade offer.",
            options: [
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "title",
                    description: "Title of the trade offer.",
                    required: true,
                },
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "auec",
                    description: "Price in aUEC",
                    required: true,
                    min_value: 1,
                },
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "stock",
                    description: "Units available (default: 1)",
                    min_value: 1,
                },
                {
                    type: ApplicationCommandOptionType.ATTACHMENT,
                    name: "image",
                    description: "Optional image showcasing the item.",
                },
            ],
        },
        {
            type: ApplicationCommandOptionType.SUB_COMMAND,
            name: "close",
            description: "Close a trade or all your open trades.",
            options: [
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "target",
                    description: "Trade ID to close or 'all' to close every open trade you created.",
                    required: true,
                },
            ],
        },
    ],
};

type OptionLookup = Record<string, InteractionDataOption | undefined>;

type AnnouncementResult = {
    url: string | null;
    messageId: string | null;
    messageChannelId: string | null;
};

type SubcommandName = "create" | "close";

type ExtractedSubcommand = {
    name: SubcommandName | null;
    options: InteractionDataOption[];
};

function buildReply(content: string, components?: MessageComponent[]): CommandResponse {
    return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
            content,
            flags: InteractionResponseFlags.EPHEMERAL,
            ...(components ? { components } : {}),
        },
    };
}

function normalizeOptions(options: InteractionDataOption[] | undefined): OptionLookup {
    if (!options) {
        return {};
    }

    return options.reduce<OptionLookup>((acc, option) => {
        acc[option.name] = option;
        return acc;
    }, {});
}

function extractSubcommand(interaction: CommandExecuteContext["interaction"]): ExtractedSubcommand {
    const options = interaction.data.options ?? [];
    const [first] = options;

    if (!first || first.type !== ApplicationCommandOptionType.SUB_COMMAND) {
        return { name: null, options: [] };
    }

    return {
        name: first.name as SubcommandName,
        options: first.options ?? [],
    };
}

function formatUserTag(params: {
    username?: string | null;
    discriminator?: string | null;
    fallbackId: string;
}): string {
    const { username, discriminator, fallbackId } = params;
    if (username && username.trim().length > 0) {
        if (discriminator && discriminator !== "0") {
            return `${username}#${discriminator}`;
        }
        return username;
    }
    return fallbackId;
}

function resolveUserTag(params: {
    userRecord?: Pick<UserRecord, "username" | "discriminator"> | null;
    interactionUser?: { username: string; discriminator?: string | null } | null;
    fallbackId: string;
}): string {
    if (params.userRecord) {
        return formatUserTag({
            username: params.userRecord.username,
            discriminator: params.userRecord.discriminator,
            fallbackId: params.fallbackId,
        });
    }

    if (params.interactionUser) {
        return formatUserTag({
            username: params.interactionUser.username,
            discriminator: params.interactionUser.discriminator ?? null,
            fallbackId: params.fallbackId,
        });
    }

    return params.fallbackId;
}

function resolveStatusLabel(status: TradeStatus): string {
    switch (status) {
        case "open":
            return "Open";
        case "complete":
            return "Closed";
        case "cancelled":
            return "Cancelled";
        case "matched":
            return "Matched";
        case "escrow":
            return "In Escrow";
        case "expired":
            return "Expired";
        default:
            return status;
    }
}

function buildTradeEmbed(params: {
    trade: TradeRecord;
    userTag: string;
    statusLabel?: string;
}): Record<string, unknown> {
    const { trade, userTag } = params;
    const statusLabel = params.statusLabel ?? resolveStatusLabel(trade.status);

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
        { name: "Price", value: `${numberFormatter.format(trade.auec)} aUEC`, inline: true },
        { name: "Stock", value: `${trade.stock}`, inline: true },
        { name: "Trade ID", value: `#${trade.id}`, inline: true },
    ];

    if (statusLabel) {
        fields.push({ name: "Status", value: statusLabel, inline: true });
    }

    const embed: Record<string, unknown> = {
        title: trade.title,
        color: 0x00ae86,
        fields,
        timestamp: new Date(trade.created_at).toISOString(),
        footer: { text: `Seller: ${userTag}` },
    };

    if (trade.image_url) {
        embed.image = { url: trade.image_url };
    }

    return embed;
}

function buildControlComponents(params: {
    closeCustomId: string;
    cancelCustomId: string;
}): MessageComponent[] {
    return [
        {
            type: ComponentType.ACTION_ROW,
            components: [
                {
                    type: ComponentType.BUTTON,
                    style: ButtonStyle.SUCCESS,
                    label: "Close",
                    custom_id: params.closeCustomId,
                },
                {
                    type: ComponentType.BUTTON,
                    style: ButtonStyle.DANGER,
                    label: "Cancel",
                    custom_id: params.cancelCustomId,
                },
            ],
        },
    ];
}

function buildAnnouncementUrl(params: {
    guildId: string;
    channelId: string | null;
    messageId: string | null;
}): string | null {
    if (!params.channelId || !params.messageId) {
        return null;
    }

    return `https://discord.com/channels/${params.guildId}/${params.channelId}/${params.messageId}`;
}

function getStringOption(lookup: OptionLookup, name: string): string | null {
    const option = lookup[name];
    if (!option || typeof option.value !== "string") {
        return null;
    }
    return option.value;
}

function getIntegerOption(lookup: OptionLookup, name: string): number | null {
    const option = lookup[name];
    if (!option || typeof option.value !== "number") {
        return null;
    }
    return option.value;
}

function resolveImageUrl(attachment: InteractionAttachment | null): string | null {
    if (!attachment) {
        return null;
    }

    if (attachment.content_type && !attachment.content_type.startsWith("image/")) {
        return null;
    }

    return attachment.url ?? null;
}

async function deliverTradeAnnouncement(params: {
    token: string;
    guildId: string;
    channelId: string;
    channelType: "text" | "forum";
    content: string;
    threadName: string;
    embed: Record<string, unknown>;
    userId: string;
}): Promise<AnnouncementResult> {
    const baseHeaders = {
        Authorization: `Bot ${params.token}`,
        "Content-Type": "application/json",
    } satisfies Record<string, string>;

    const allowedMentions = {
        parse: [] as string[],
        users: [params.userId],
    };

    if (params.channelType === "text") {
        const response = await fetch(`https://discord.com/api/v10/channels/${params.channelId}/messages`, {
            method: "POST",
            headers: baseHeaders,
            body: JSON.stringify({
                content: params.content,
                embeds: [params.embed],
                allowed_mentions: allowedMentions,
            }),
        });

        if (!response.ok) {
            const message = await response.text();
            throw new Error(`Failed to post trade announcement: ${response.status} ${message}`);
        }

        const messageData = (await response.json()) as { id?: string | null };
        const messageId = messageData.id ?? null;
        return {
            url: messageId ? `https://discord.com/channels/${params.guildId}/${params.channelId}/${messageId}` : null,
            messageId,
            messageChannelId: messageId ? params.channelId : null,
        };
    }

    const response = await fetch(`https://discord.com/api/v10/channels/${params.channelId}/threads`, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({
            name: params.threadName,
            message: {
                content: params.content,
                embeds: [params.embed],
                allowed_mentions: allowedMentions,
            },
        }),
    });

    if (!response.ok) {
        const message = await response.text();
        throw new Error(`Failed to create forum thread: ${response.status} ${message}`);
    }

    const threadData = (await response.json()) as {
        id?: string | null;
        message?: { id?: string | null } | null;
    };
    const threadId = threadData.id ?? null;
    const starterMessageId = threadData.message?.id ?? null;
    return {
        url: threadId ? `https://discord.com/channels/${params.guildId}/${threadId}` : null,
        messageId: starterMessageId,
        messageChannelId: starterMessageId && threadId ? threadId : null,
    };
}

async function patchTradeAnnouncement(params: {
    token: string;
    channelId: string;
    messageId: string;
    embed: Record<string, unknown>;
    content?: string;
    components?: MessageComponent[];
}): Promise<void> {
    const payload: Record<string, unknown> = {
        embeds: [params.embed],
    };

    if (typeof params.content === "string") {
        payload.content = params.content;
    }

    if (params.components !== undefined) {
        payload.components = params.components;
    }

    const response = await fetch(`https://discord.com/api/v10/channels/${params.channelId}/messages/${params.messageId}`, {
        method: "PATCH",
        headers: {
            Authorization: `Bot ${params.token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const message = await response.text();
        throw new Error(`Failed to update trade announcement: ${response.status} ${message}`);
    }
}

async function handleCreateSubcommand(params: {
    interaction: CommandExecuteContext["interaction"];
    config: CommandExecuteContext["config"];
    options: InteractionDataOption[];
    user: InteractionUser;
}): Promise<CommandResponse> {
    const { interaction, config, options, user } = params;
    const guildId = interaction.guild_id!;

    const lookup = normalizeOptions(options);
    const title = getStringOption(lookup, "title");
    const auec = getIntegerOption(lookup, "auec");
    const stock = getIntegerOption(lookup, "stock") ?? 1;
    const attachmentId = getStringOption(lookup, "image");
    const attachment = attachmentId
        ? interaction.data.resolved?.attachments?.[attachmentId] ?? null
        : null;
    const imageUrl = resolveImageUrl(attachment);

    if (!title || !auec) {
        return buildReply("Title and price are required.");
    }

    await recordGuild(guildId, guildId);
    await recordUser({
        id: user.id,
        username: user.username,
        displayName: interaction.member?.nick ?? user.global_name ?? null,
        discriminator: user.discriminator ?? null,
    });

    const tradeConfig = await getTradeConfig(guildId);
    if (!tradeConfig.tradeChannelId || !tradeConfig.tradeChannelType) {
        return buildReply(
            "No trade channel is configured. Ask an administrator to set one with /tradeconfig channel."
        );
    }

    const trade = await createTrade({
        guildId,
        userId: user.id,
        title,
        auec,
        stock,
        imageUrl,
    });

    const closeCustomId = `trade:${trade.id}:close`;
    const cancelCustomId = `trade:${trade.id}:cancel`;
    const replyComponents = buildControlComponents({ closeCustomId, cancelCustomId });

    let controlMetadataError: Error | null = null;
    try {
        await updateTradeAnnouncementMetadata({
            tradeId: trade.id,
            closeButtonId: closeCustomId,
            cancelButtonId: cancelCustomId,
        });
    } catch (error) {
        controlMetadataError = error instanceof Error
            ? error
            : new Error("Unknown error while storing control metadata.");
        console.error("Failed to store trade control metadata", error);
    }

    const userTag = resolveUserTag({
        interactionUser: user,
        fallbackId: user.id,
    });

    const embed = buildTradeEmbed({
        trade,
        userTag,
        statusLabel: "Open",
    });

    const content = `New trade from <@${user.id}>`;
    const threadName = `${trade.title} (#${trade.id})`;

    let announcementUrl: string | null = null;
    let announcementError: Error | null = null;
    let announcementMetadataError: Error | null = null;
    let announcementPatchError: Error | null = null;

    if (!config.allowOffline) {
        try {
            const result = await deliverTradeAnnouncement({
                token: config.botToken,
                guildId,
                channelId: tradeConfig.tradeChannelId,
                channelType: tradeConfig.tradeChannelType,
                content,
                threadName,
                embed,
                userId: user.id,
            });
            announcementUrl = result.url;

            if (result.messageId && result.messageChannelId) {
                try {
                    await updateTradeAnnouncementMetadata({
                        tradeId: trade.id,
                        channelId: result.messageChannelId,
                        messageId: result.messageId,
                    });
                } catch (error) {
                    announcementMetadataError = error instanceof Error
                        ? error
                        : new Error("Unknown error while storing announcement metadata.");
                    console.error("Failed to store trade announcement metadata", error);
                }

                try {
                    await patchTradeAnnouncement({
                        token: config.botToken,
                        channelId: result.messageChannelId,
                        messageId: result.messageId,
                        embed,
                    });
                } catch (error) {
                    announcementPatchError = error instanceof Error
                        ? error
                        : new Error("Unknown error while updating the trade announcement.");
                    console.error("Failed to patch trade announcement", error);
                }
            }
        } catch (error) {
            announcementError = error instanceof Error
                ? error
                : new Error("Unknown error while sending trade announcement.");
            console.error("Failed to announce trade", error);
        }
    }

    const confirmationLines = [
        `Trade #${trade.id} created successfully.`,
        announcementUrl ? `Announcement: ${announcementUrl}` : undefined,
        "Use the buttons below to manage this trade.",
        announcementError ? "Warning: Failed to post the trade announcement." : undefined,
        controlMetadataError ? "Warning: Failed to store trade control metadata." : undefined,
        announcementMetadataError ? "Warning: Failed to store announcement metadata." : undefined,
        announcementPatchError ? "Warning: Failed to update the trade announcement." : undefined,
        config.allowOffline ? "Offline mode: announcement was not sent." : undefined,
    ].filter(Boolean);

    return buildReply(confirmationLines.join("\n"), replyComponents);
}

async function handleCloseSubcommand(params: {
    interaction: CommandExecuteContext["interaction"];
    config: CommandExecuteContext["config"];
    options: InteractionDataOption[];
    user: InteractionUser;
}): Promise<CommandResponse> {
    const { interaction, config, options, user } = params;
    const lookup = normalizeOptions(options);
    const targetRaw = getStringOption(lookup, "target");

    if (!targetRaw) {
        return buildReply("Provide the trade ID to close or 'all' to close all open trades.");
    }

    const normalizedTarget = targetRaw.trim().toLowerCase();

    if (normalizedTarget === "all") {
        return handleCloseAllSubcommand({ interaction, config, user });
    }

    const tradeId = Number(targetRaw);
    if (!Number.isInteger(tradeId) || tradeId <= 0) {
        return buildReply("Provide a valid trade ID or 'all'.");
    }

    return handleCloseSingleSubcommand({ interaction, config, user, tradeId });
}

async function handleCloseSingleSubcommand(params: {
    interaction: CommandExecuteContext["interaction"];
    config: CommandExecuteContext["config"];
    user: InteractionUser;
    tradeId: number;
}): Promise<CommandResponse> {
    const { interaction, config, user, tradeId } = params;
    const guildId = interaction.guild_id!;

    const existing = await getTradeById(tradeId);
    if (!existing || existing.guild_id !== guildId) {
        return buildReply(`Trade #${tradeId} does not exist for this guild.`);
    }

    if (existing.user_id !== user.id) {
        return buildReply("You can only close your own trades.");
    }

    if (existing.status !== "open") {
        const statusLabel = resolveStatusLabel(existing.status);
        return buildReply(`Trade #${tradeId} is already ${statusLabel}.`);
    }

    const updated = await updateTradeStatus({ tradeId, status: "complete" });
    if (!updated) {
        return buildReply("Failed to update the trade status. Try again in a moment.");
    }

    const storedUser = await getUserById(user.id);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        interactionUser: user,
        fallbackId: user.id,
    });

    const announcementUrl = buildAnnouncementUrl({
        guildId,
        channelId: updated.announcement_channel_id,
        messageId: updated.announcement_message_id,
    });

    let announcementPatchError: Error | null = null;
    let missingAnnouncementMetadata = false;

    if (!config.allowOffline) {
        if (updated.announcement_channel_id && updated.announcement_message_id) {
            try {
                const embed = buildTradeEmbed({
                    trade: updated,
                    userTag,
                    statusLabel: "Closed",
                });

                await patchTradeAnnouncement({
                    token: config.botToken,
                    channelId: updated.announcement_channel_id,
                    messageId: updated.announcement_message_id,
                    embed,
                    components: [],
                });
            } catch (error) {
                announcementPatchError = error instanceof Error
                    ? error
                    : new Error("Unknown error while updating the trade announcement.");
                console.error(`Failed to patch trade announcement for trade #${tradeId}`, error);
            }
        } else {
            missingAnnouncementMetadata = true;
        }
    }

    const responseLines = [
        `Trade #${updated.id} marked as closed.`,
        announcementUrl ? `Announcement: ${announcementUrl}` : undefined,
        config.allowOffline ? "Offline mode: announcement was not updated." : undefined,
        missingAnnouncementMetadata ? "No stored announcement message to update." : undefined,
        announcementPatchError ? "Warning: Failed to update the trade announcement." : undefined,
    ].filter(Boolean);

    return buildReply(responseLines.join("\n"));
}

async function handleCloseAllSubcommand(params: {
    interaction: CommandExecuteContext["interaction"];
    config: CommandExecuteContext["config"];
    user: InteractionUser;
}): Promise<CommandResponse> {
    const { interaction, config, user } = params;
    const guildId = interaction.guild_id!;

    const openTrades = await listTradesByUser({
        guildId,
        userId: user.id,
        status: "open",
    });

    if (openTrades.length === 0) {
        return buildReply("You have no open trades to close.");
    }

    const storedUser = await getUserById(user.id);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        interactionUser: user,
        fallbackId: user.id,
    });

    const closedTradeIds: number[] = [];
    const patchFailures: number[] = [];
    let missingAnnouncementCount = 0;

    for (const trade of openTrades) {
        const updated = await updateTradeStatus({ tradeId: trade.id, status: "complete" });
        if (!updated) {
            patchFailures.push(trade.id);
            console.error(`Failed to update trade status for trade #${trade.id}`);
            continue;
        }

        closedTradeIds.push(updated.id);

        if (config.allowOffline) {
            continue;
        }

        if (!updated.announcement_channel_id || !updated.announcement_message_id) {
            missingAnnouncementCount += 1;
            continue;
        }

        try {
            const embed = buildTradeEmbed({
                trade: updated,
                userTag,
                statusLabel: "Closed",
            });

            await patchTradeAnnouncement({
                token: config.botToken,
                channelId: updated.announcement_channel_id,
                messageId: updated.announcement_message_id,
                embed,
                components: [],
            });
        } catch (error) {
            patchFailures.push(updated.id);
            console.error(`Failed to patch trade announcement for trade #${updated.id}`, error);
        }
    }

    const lines = [
        `Closed ${closedTradeIds.length} trade${closedTradeIds.length === 1 ? "" : "s"}.`,
        closedTradeIds.length ? `Trades: ${closedTradeIds.map((id) => `#${id}`).join(", ")}` : undefined,
        config.allowOffline ? "Offline mode: announcements were not updated." : undefined,
        !config.allowOffline && missingAnnouncementCount > 0
            ? `${missingAnnouncementCount} trade${missingAnnouncementCount === 1 ? "" : "s"} did not have announcement metadata stored.`
            : undefined,
        patchFailures.length > 0
            ? `Warning: Failed to update announcements for ${patchFailures.map((id) => `#${id}`).join(", ")}.`
            : undefined,
    ].filter(Boolean);

    return buildReply(lines.join("\n"));
}

const sellCommand: CommandModule = {
    data: commandData,
    async execute({ interaction, config }: CommandExecuteContext) {
        if (!interaction.guild_id || !interaction.member) {
            return buildReply("Trades can only be managed inside a guild.");
        }

        const user = interaction.member.user ?? interaction.user;
        if (!user) {
            return buildReply("Unable to determine the user for this interaction.");
        }

        const { name: subcommandName, options } = extractSubcommand(interaction);

        if (!subcommandName || subcommandName === "create") {
            return handleCreateSubcommand({
                interaction,
                config,
                options,
                user,
            });
        }

        if (subcommandName === "close") {
            return handleCloseSubcommand({
                interaction,
                config,
                options,
                user,
            });
        }

        return buildReply("Unsupported subcommand for /sell.");
    },
};

export default sellCommand;
