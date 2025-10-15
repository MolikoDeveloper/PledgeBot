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
    reduceTradeStock,
    recordGuild,
    recordUser,
    updateTradeAnnouncementMetadata,
    updateTradeDiscount,
    type TradeRecord,
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
import {
    buildAnnouncementUrl,
    buildTradeAnnouncementContent,
    buildTradeEmbed,
    patchTradeAnnouncement,
    resolveStatusLabel,
    resolveUserTag,
} from "./trade-utils";

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
            name: "done",
            description: "Mark trade units as sold or mark all trades as sold.",
            options: [
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "target",
                    description: "Trade ID to mark as done or 'todos' to mark every open trade you created.",
                    required: true,
                },
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "amount",
                    description: "Units sold (default: 1)",
                    min_value: 1,
                },
            ],
        },
        {
            type: ApplicationCommandOptionType.SUB_COMMAND,
            name: "discount",
            description: "Adjust the discount applied to a trade.",
            options: [
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "id",
                    description: "Trade ID to update.",
                    required: true,
                    min_value: 1,
                },
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "percent",
                    description: "Discount percentage (0 removes the discount).",
                    required: true,
                    min_value: 0,
                    max_value: 95,
                },
            ],
        },
    ],
};

const numberFormatter = new Intl.NumberFormat("en-US");

type OptionLookup = Record<string, InteractionDataOption | undefined>;

type AnnouncementResult = {
    url: string | null;
    messageId: string | null;
    messageChannelId: string | null;
};

type SubcommandName = "create" | "done" | "discount";

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

function buildControlComponents(params: {
    stock: number;
    doneOneCustomId: string;
    doneAllCustomId: string | null;
    cancelCustomId: string;
}): MessageComponent[] {
    if (params.stock <= 0) {
        return [];
    }

    const buttons: MessageComponent["components"] = [
        {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SUCCESS,
            label: "Done 1 item",
            custom_id: params.doneOneCustomId,
        },
    ];

    if (params.stock > 1 && params.doneAllCustomId) {
        buttons.push({
            type: ComponentType.BUTTON,
            style: ButtonStyle.PRIMARY,
            label: "Done all",
            custom_id: params.doneAllCustomId,
        });
    }

    buttons.push({
        type: ComponentType.BUTTON,
        style: ButtonStyle.DANGER,
        label: "Cancel",
        custom_id: params.cancelCustomId,
    });

    return [
        {
            type: ComponentType.ACTION_ROW,
            components: buttons,
        },
    ];
}

function resolveTradeComponents(trade: TradeRecord): MessageComponent[] {
    if (trade.status !== "open" || trade.stock <= 0) {
        return [];
    }

    if (!trade.done_one_button_custom_id || !trade.cancel_button_custom_id) {
        return [];
    }

    return buildControlComponents({
        stock: trade.stock,
        doneOneCustomId: trade.done_one_button_custom_id,
        doneAllCustomId: trade.done_all_button_custom_id,
        cancelCustomId: trade.cancel_button_custom_id,
    });
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

    const doneOneCustomId = `trade:${trade.id}:done:one`;
    const doneAllCustomId = trade.stock > 1 ? `trade:${trade.id}:done:all` : null;
    const cancelCustomId = `trade:${trade.id}:cancel`;
    const replyComponents = buildControlComponents({
        stock: trade.stock,
        doneOneCustomId,
        doneAllCustomId,
        cancelCustomId,
    });

    let controlMetadataError: Error | null = null;
    try {
        await updateTradeAnnouncementMetadata({
            tradeId: trade.id,
            doneOneButtonId: doneOneCustomId,
            doneAllButtonId: doneAllCustomId,
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

    const content = buildTradeAnnouncementContent({ trade, userId: user.id });
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
                        content,
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

async function handleDoneSubcommand(params: {
    interaction: CommandExecuteContext["interaction"];
    config: CommandExecuteContext["config"];
    options: InteractionDataOption[];
    user: InteractionUser;
}): Promise<CommandResponse> {
    const { interaction, config, options, user } = params;
    const lookup = normalizeOptions(options);
    const targetRaw = getStringOption(lookup, "target");
    const amountOption = getIntegerOption(lookup, "amount");

    if (!targetRaw) {
        return buildReply("Provide the trade ID to mark as done or 'todos' to update all open trades.");
    }

    if (amountOption !== null && (!Number.isInteger(amountOption) || amountOption <= 0)) {
        return buildReply("Provide a valid amount of units to mark as done (minimum 1).");
    }

    const normalizedTarget = targetRaw.trim().toLowerCase();

    if (normalizedTarget === "todos" || normalizedTarget === "all") {
        if (amountOption !== null) {
            return buildReply("The amount option cannot be used when marking all trades.");
        }
        return handleDoneAllSubcommand({ interaction, config, user });
    }

    const tradeId = Number(targetRaw);
    if (!Number.isInteger(tradeId) || tradeId <= 0) {
        return buildReply("Provide a valid trade ID or 'todos'.");
    }

    const amount = amountOption ?? 1;
    const trade = await getTradeById(tradeId);
    if (!trade || trade.guild_id !== interaction.guild_id) {
        return buildReply(`Trade #${tradeId} does not exist for this guild.`);
    }

    if (trade.user_id !== user.id) {
        return buildReply("You can only manage your own trades.");
    }

    if (trade.status !== "open") {
        const statusLabel = resolveStatusLabel(trade.status);
        return buildReply(`Trade #${trade.id} is already ${statusLabel}.`);
    }

    if (trade.stock <= 0) {
        return buildReply(`Trade #${trade.id} has no remaining stock.`);
    }

    const updated = await reduceTradeStock({ tradeId: trade.id, amount });
    if (!updated) {
        return buildReply(
            `Unable to mark ${amount === 1 ? "1 item" : `${amount} items`} as done for trade #${trade.id}. Check the available stock and try again.`,
        );
    }

    const storedUser = await getUserById(user.id);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        interactionUser: user,
        fallbackId: user.id,
    });

    const embed = buildTradeEmbed({ trade: updated, userTag });
    const announcementContent = buildTradeAnnouncementContent({
        trade: updated,
        userId: updated.user_id,
    });
    const announcementUrl = buildAnnouncementUrl({
        guildId: interaction.guild_id!,
        channelId: updated.announcement_channel_id,
        messageId: updated.announcement_message_id,
    });
    const replyComponents = resolveTradeComponents(updated);

    let metadataError: Error | null = null;
    if (updated.status !== "open") {
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
            console.error("Failed to clear trade control metadata", error);
        }
    }

    let announcementPatchError: Error | null = null;
    let missingAnnouncementMetadata = false;

    if (!config.allowOffline) {
        if (updated.announcement_channel_id && updated.announcement_message_id) {
            try {
                await patchTradeAnnouncement({
                    token: config.botToken,
                    channelId: updated.announcement_channel_id,
                    messageId: updated.announcement_message_id,
                    embed,
                    content: announcementContent,
                    components: updated.status === "open" ? replyComponents : [],
                });
            } catch (error) {
                announcementPatchError =
                    error instanceof Error ? error : new Error("Unknown announcement update failure.");
                console.error(`Failed to patch trade announcement for trade #${trade.id}`, error);
            }
        } else {
            missingAnnouncementMetadata = true;
        }
    }

    const amountText = amount === 1 ? "1 item" : `${amount} items`;
    const responseLines = [
        `Marked ${amountText} as done for trade #${updated.id}.`,
        updated.status === "open" ? `Remaining stock: ${updated.stock}.` : "Trade is now marked as sold out.",
        announcementUrl ? `Announcement: ${announcementUrl}` : undefined,
        config.allowOffline ? "Offline mode: announcement was not updated." : undefined,
        missingAnnouncementMetadata ? "No stored announcement message to update." : undefined,
        announcementPatchError ? "Warning: Failed to update the trade announcement." : undefined,
        metadataError ? "Warning: Failed to update stored control metadata." : undefined,
    ].filter(Boolean);

    return buildReply(responseLines.join("\n"), replyComponents.length > 0 ? replyComponents : undefined);
}

async function handleDiscountSubcommand(params: {
    interaction: CommandExecuteContext["interaction"];
    config: CommandExecuteContext["config"];
    options: InteractionDataOption[];
    user: InteractionUser;
}): Promise<CommandResponse> {
    const { interaction, config, options, user } = params;
    const lookup = normalizeOptions(options);

    const tradeId = getIntegerOption(lookup, "id");
    const percentOption = getIntegerOption(lookup, "percent");

    if (!tradeId || tradeId <= 0) {
        return buildReply("Provide a valid trade ID to update the discount.");
    }

    if (percentOption === null || percentOption < 0 || percentOption > 95) {
        return buildReply("Provide a discount percentage between 0 and 95.");
    }

    const trade = await getTradeById(tradeId);
    if (!trade || trade.guild_id !== interaction.guild_id) {
        return buildReply(`Trade #${tradeId} does not exist for this guild.`);
    }

    if (trade.user_id !== user.id) {
        return buildReply("You can only manage your own trades.");
    }

    if (trade.status !== "open") {
        const statusLabel = resolveStatusLabel(trade.status);
        return buildReply(`Trade #${trade.id} is already ${statusLabel}.`);
    }

    const normalizedPercent = percentOption === 0 ? null : percentOption;

    const updated = await updateTradeDiscount({
        tradeId: trade.id,
        percent: normalizedPercent,
    });

    if (!updated) {
        return buildReply(`Unable to update the discount for trade #${trade.id}.`);
    }

    const storedUser = await getUserById(updated.user_id);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        interactionUser: user,
        fallbackId: updated.user_id,
    });

    const embed = buildTradeEmbed({ trade: updated, userTag });
    const announcementContent = buildTradeAnnouncementContent({
        trade: updated,
        userId: updated.user_id,
    });

    const announcementUrl = buildAnnouncementUrl({
        guildId: interaction.guild_id!,
        channelId: updated.announcement_channel_id,
        messageId: updated.announcement_message_id,
    });

    let missingAnnouncementMetadata = false;
    let announcementPatchError: Error | null = null;

    if (!config.allowOffline) {
        if (updated.announcement_channel_id && updated.announcement_message_id) {
            try {
                await patchTradeAnnouncement({
                    token: config.botToken,
                    channelId: updated.announcement_channel_id,
                    messageId: updated.announcement_message_id,
                    embed,
                    content: announcementContent,
                });
            } catch (error) {
                announcementPatchError =
                    error instanceof Error ? error : new Error("Unknown announcement update failure.");
                console.error(`Failed to patch trade announcement for trade #${trade.id}`, error);
            }
        } else {
            missingAnnouncementMetadata = true;
        }
    }

    const originalPrice = numberFormatter.format(updated.auec);
    const discountedPrice =
        updated.discounted_auec !== null ? numberFormatter.format(updated.discounted_auec) : null;

    const discountLine = normalizedPercent === null
        ? `Removed the discount for trade #${updated.id}.`
        : `Trade #${updated.id} discounted ${updated.discount_percent}%: ${originalPrice} aUEC → ${
              discountedPrice ?? originalPrice
          } aUEC.`;

    const lines = [
        discountLine,
        announcementUrl ? `Announcement: ${announcementUrl}` : undefined,
        config.allowOffline ? "Offline mode: announcement was not updated." : undefined,
        missingAnnouncementMetadata ? "No stored announcement message to update." : undefined,
        announcementPatchError ? "Warning: Failed to update the trade announcement." : undefined,
    ].filter(Boolean);

    return buildReply(lines.join("\n"));
}

async function handleDoneAllSubcommand(params: {
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
        return buildReply("You have no open trades to update.");
    }

    const storedUser = await getUserById(user.id);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        interactionUser: user,
        fallbackId: user.id,
    });

    const updatedTradeIds: number[] = [];
    const patchFailures: number[] = [];
    const metadataFailures: number[] = [];
    const updateFailures: number[] = [];
    let missingAnnouncementCount = 0;

    for (const trade of openTrades) {
        if (trade.stock <= 0) {
            continue;
        }

        const updated = await reduceTradeStock({ tradeId: trade.id, amount: trade.stock });
        if (!updated) {
            updateFailures.push(trade.id);
            console.error(`Failed to update trade stock for trade #${trade.id}`);
            continue;
        }

        updatedTradeIds.push(updated.id);

        if (config.allowOffline) {
            if (updated.status !== "open") {
                try {
                    await updateTradeAnnouncementMetadata({
                        tradeId: updated.id,
                        doneOneButtonId: null,
                        doneAllButtonId: null,
                        cancelButtonId: null,
                    });
                } catch (error) {
                    metadataFailures.push(updated.id);
                    console.error(`Failed to clear trade control metadata for trade #${updated.id}`, error);
                }
            }
            continue;
        }

        if (!updated.announcement_channel_id || !updated.announcement_message_id) {
            missingAnnouncementCount += 1;
            if (updated.status !== "open") {
                try {
                    await updateTradeAnnouncementMetadata({
                        tradeId: updated.id,
                        doneOneButtonId: null,
                        doneAllButtonId: null,
                        cancelButtonId: null,
                    });
                } catch (error) {
                    metadataFailures.push(updated.id);
                    console.error(`Failed to clear trade control metadata for trade #${updated.id}`, error);
                }
            }
            continue;
        }

        try {
            const embed = buildTradeEmbed({ trade: updated, userTag });
            const components = updated.status === "open" ? resolveTradeComponents(updated) : [];
            const announcementContent = buildTradeAnnouncementContent({
                trade: updated,
                userId: updated.user_id,
            });

            await patchTradeAnnouncement({
                token: config.botToken,
                channelId: updated.announcement_channel_id,
                messageId: updated.announcement_message_id,
                embed,
                content: announcementContent,
                components,
            });
        } catch (error) {
            patchFailures.push(updated.id);
            console.error(`Failed to patch trade announcement for trade #${updated.id}`, error);
        }

        if (updated.status !== "open") {
            try {
                await updateTradeAnnouncementMetadata({
                    tradeId: updated.id,
                    doneOneButtonId: null,
                    doneAllButtonId: null,
                    cancelButtonId: null,
                });
            } catch (error) {
                metadataFailures.push(updated.id);
                console.error(`Failed to clear trade control metadata for trade #${updated.id}`, error);
            }
        }
    }

    const lines = [
        `Updated ${updatedTradeIds.length} trade${updatedTradeIds.length === 1 ? "" : "s"}.`,
        updatedTradeIds.length ? `Trades: ${updatedTradeIds.map((id) => `#${id}`).join(", ")}` : undefined,
        config.allowOffline ? "Offline mode: announcements were not updated." : undefined,
        !config.allowOffline && missingAnnouncementCount > 0
            ? `${missingAnnouncementCount} trade${missingAnnouncementCount === 1 ? "" : "s"} did not have announcement metadata stored.`
            : undefined,
        updateFailures.length > 0
            ? `Warning: Failed to update stock for ${updateFailures.map((id) => `#${id}`).join(", ")}.`
            : undefined,
        patchFailures.length > 0
            ? `Warning: Failed to update announcements for ${patchFailures.map((id) => `#${id}`).join(", ")}.`
            : undefined,
        metadataFailures.length > 0
            ? `Warning: Failed to update stored control metadata for ${metadataFailures
                  .map((id) => `#${id}`)
                  .join(", ")}.`
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

        if (subcommandName === "done") {
            return handleDoneSubcommand({
                interaction,
                config,
                options,
                user,
            });
        }

        if (subcommandName === "discount") {
            return handleDiscountSubcommand({
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
