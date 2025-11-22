import {
    InteractionResponseFlags,
    InteractionResponseType,
} from "discord-interactions";

import {
    createBuyOrder,
    getBuyOrderById,
    getTradeConfig,
    getUserById,
    listBuyOrdersByUser,
    recordGuild,
    recordUser,
    updateBuyOrderAnnouncementMetadata,
    updateBuyOrderStatus,
    type BuyOrderRecord,
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
    buildBuyOrderAnnouncementContent,
    buildBuyOrderEmbed,
    buildBuyThreadName,
    deliverTradeAnnouncement,
    patchTradeAnnouncement,
    resolveBuyStatusLabel,
    resolveForumThreadId,
    resolveUserTag,
    shouldArchiveBuyThread,
    type AnnouncementResult,
    updateForumThread,
} from "./trade-utils";

const commandData: CommandData = {
    name: "buy",
    description: "Manage buy orders.",
    dm_permission: false,
    options: [
        {
            type: ApplicationCommandOptionType.SUB_COMMAND,
            name: "create",
            description: "Publish a new buy order.",
            options: [
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "item",
                    description: "Item or service you want to buy.",
                    required: true,
                },
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "price",
                    description: "Offered price in aUEC.",
                    required: true,
                    min_value: 1,
                },
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "amount",
                    description: "Desired quantity (optional).",
                    min_value: 1,
                },
                {
                    type: ApplicationCommandOptionType.ATTACHMENT,
                    name: "attachment",
                    description: "Optional reference image.",
                },
            ],
        },
        {
            type: ApplicationCommandOptionType.SUB_COMMAND,
            name: "done",
            description: "Mark a buy order as fulfilled or close all of your open orders.",
            options: [
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "target",
                    description: "Buy order ID to mark as done or 'todos' to mark every open order you created.",
                    required: true,
                },
            ],
        },
        {
            type: ApplicationCommandOptionType.SUB_COMMAND,
            name: "cancel",
            description: "Cancel one of your buy orders.",
            options: [
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "id",
                    description: "Buy order ID to cancel.",
                    required: true,
                    min_value: 1,
                },
            ],
        },
    ],
};

type OptionLookup = Record<string, InteractionDataOption>;
type ExtractedSubcommand = { name: "create" | "done" | "cancel" | null; options: InteractionDataOption[] };
type GuildTradeConfig = Awaited<ReturnType<typeof getTradeConfig>>;

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
        name: first.name as ExtractedSubcommand["name"],
        options: first.options ?? [],
    };
}

function buildControlComponents(params: { doneCustomId: string; cancelCustomId: string }): MessageComponent[] {
    const buttons: MessageComponent["components"] = [
        {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SUCCESS,
            label: "Mark done",
            custom_id: params.doneCustomId,
        },
        {
            type: ComponentType.BUTTON,
            style: ButtonStyle.DANGER,
            label: "Cancel",
            custom_id: params.cancelCustomId,
        },
    ];

    return [
        {
            type: ComponentType.ACTION_ROW,
            components: buttons,
        },
    ];
}

function resolveBuyComponents(order: BuyOrderRecord): MessageComponent[] {
    if (order.status !== "open") {
        return [];
    }

    if (!order.done_button_custom_id || !order.cancel_button_custom_id) {
        return [];
    }

    return buildControlComponents({
        doneCustomId: order.done_button_custom_id,
        cancelCustomId: order.cancel_button_custom_id,
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

async function clearBuyControls(orderId: number): Promise<Error | null> {
    try {
        await updateBuyOrderAnnouncementMetadata({
            orderId,
            doneButtonId: null,
            cancelButtonId: null,
        });
        return null;
    } catch (error) {
        const err = error instanceof Error ? error : new Error("Unknown metadata update failure");
        console.error(`Failed to clear buy component metadata for order #${orderId}`, error);
        return err;
    }
}

function resolveForumThreadIdForOrder(order: BuyOrderRecord, tradeConfig: GuildTradeConfig): string | null {
    return resolveForumThreadId({
        announcementChannelId: order.announcement_channel_id,
        tradeChannelId: tradeConfig.tradeChannelId,
        tradeChannelType: tradeConfig.tradeChannelType,
    });
}

async function syncBuyForumThread(params: {
    config: CommandExecuteContext["config"];
    tradeConfig: GuildTradeConfig;
    order: BuyOrderRecord;
}): Promise<Error | null> {
    if (params.config.allowOffline) {
        return null;
    }

    const threadId = resolveForumThreadIdForOrder(params.order, params.tradeConfig);
    if (!threadId) {
        return null;
    }

    const archiveThread = shouldArchiveBuyThread(params.order.status);

    try {
        await updateForumThread({
            token: params.config.botToken,
            threadId,
            name: buildBuyThreadName(params.order),
            ...(archiveThread ? { archived: true, locked: true } : {}),
        });
        return null;
    } catch (error) {
        const err = error instanceof Error ? error : new Error("Unknown forum thread update failure.");
        console.error(`Failed to update forum thread for buy order #${params.order.id}`, error);
        return err;
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
    const item = getStringOption(lookup, "item")?.trim();
    const priceOption = getIntegerOption(lookup, "price");
    const amountOption = getIntegerOption(lookup, "amount");
    const attachmentId = getStringOption(lookup, "attachment");
    const attachment = attachmentId
        ? interaction.data.resolved?.attachments?.[attachmentId] ?? null
        : null;
    const attachmentUrl = resolveImageUrl(attachment);

    if (!item) {
        return buildReply("Provide the item or service you want to buy.");
    }

    if (!priceOption || priceOption <= 0 || !Number.isInteger(priceOption)) {
        return buildReply("Provide a valid price greater than 0.");
    }

    if (amountOption !== null && (amountOption <= 0 || !Number.isInteger(amountOption))) {
        return buildReply("If provided, the amount must be a positive integer.");
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
        return buildReply("No trade channel configured. Ask an administrator to set one with /tradeconfig channel.");
    }

    const order = await createBuyOrder({
        guildId,
        userId: user.id,
        item,
        price: priceOption,
        amount: amountOption,
        attachmentUrl,
    });

    const doneCustomId = `buy:${order.id}:done`;
    const cancelCustomId = `buy:${order.id}:cancel`;
    const replyComponents = buildControlComponents({ doneCustomId, cancelCustomId });

    let controlMetadataError: Error | null = null;
    try {
        await updateBuyOrderAnnouncementMetadata({
            orderId: order.id,
            doneButtonId: doneCustomId,
            cancelButtonId: cancelCustomId,
        });
    } catch (error) {
        controlMetadataError = error instanceof Error
            ? error
            : new Error("Unknown error while storing control metadata.");
        console.error("Failed to store buy order control metadata", error);
    }

    const orderWithControls: BuyOrderRecord = {
        ...order,
        done_button_custom_id: doneCustomId,
        cancel_button_custom_id: cancelCustomId,
    };

    const userTag = resolveUserTag({
        interactionUser: user,
        fallbackId: user.id,
    });

    const embed = buildBuyOrderEmbed({
        order: orderWithControls,
        userTag,
        statusLabel: "Open",
    });
    const content = buildBuyOrderAnnouncementContent({ order: orderWithControls, userId: user.id });
    const threadName = buildBuyThreadName(orderWithControls);

    let announcementUrl: string | null = null;
    let announcementError: Error | null = null;
    let announcementMetadataError: Error | null = null;
    let storedChannelId = order.announcement_channel_id;
    let storedMessageId = order.announcement_message_id;

    const configuredForumTags =
        tradeConfig.tradeChannelType === "forum" ? tradeConfig.buyForumTagIds : [];
    const appliedForumTags = configuredForumTags.length > 0 ? configuredForumTags : undefined;

    if (!config.allowOffline) {
        try {
            const result: AnnouncementResult = await deliverTradeAnnouncement({
                token: config.botToken,
                guildId,
                channelId: tradeConfig.tradeChannelId!,
                channelType: tradeConfig.tradeChannelType!,
                content,
                threadName,
                embed,
                userId: user.id,
                appliedTags: appliedForumTags,
                components: replyComponents,
            });
            announcementUrl = result.url;

            if (result.messageId && result.messageChannelId) {
                try {
                    await updateBuyOrderAnnouncementMetadata({
                        orderId: order.id,
                        channelId: result.messageChannelId,
                        messageId: result.messageId,
                    });
                    storedChannelId = result.messageChannelId;
                    storedMessageId = result.messageId;
                } catch (error) {
                    announcementMetadataError = error instanceof Error
                        ? error
                        : new Error("Unknown error while storing announcement metadata.");
                    console.error("Failed to store buy order announcement metadata", error);
                }
            }
        } catch (error) {
            announcementError = error instanceof Error
                ? error
                : new Error("Unknown error while sending the buy order announcement.");
            console.error("Failed to announce buy order", error);
        }
    }

    const fallbackUrl = buildAnnouncementUrl({
        guildId,
        channelId: storedChannelId,
        messageId: storedMessageId,
    });

    const announcementLink = announcementUrl ?? fallbackUrl;
    const forumTagConfirmation =
        appliedForumTags && !announcementError && !config.allowOffline
            ? `Applied forum ${appliedForumTags.length === 1 ? "tag" : "tags"}: ${appliedForumTags.join(", ")}`
            : undefined;

    const responseLines = [
        `Buy order #${order.id} created successfully.`,
        announcementLink ? `Announcement: ${announcementLink}` : undefined,
        forumTagConfirmation,
        config.allowOffline ? "Offline mode: announcement was not sent." : undefined,
        announcementError ? "Warning: Failed to post the buy order announcement." : undefined,
        announcementMetadataError ? "Warning: Failed to store announcement metadata." : undefined,
        controlMetadataError ? "Warning: Failed to store control metadata." : undefined,
    ].filter(Boolean);

    return buildReply(responseLines.join("\n"), replyComponents.length > 0 ? replyComponents : undefined);
}

async function handleDoneSubcommand(params: {
    interaction: CommandExecuteContext["interaction"];
    config: CommandExecuteContext["config"];
    options: InteractionDataOption[];
    user: InteractionUser;
}): Promise<CommandResponse> {
    const { interaction, config, options, user } = params;
    const lookup = normalizeOptions(options);
    const target = getStringOption(lookup, "target");

    if (!target) {
        return buildReply("Provide a buy order ID or 'todos'.");
    }

    if (target.toLowerCase() === "todos") {
        return handleDoneAllSubcommand({ interaction, config, user });
    }

    const orderId = Number.parseInt(target, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
        return buildReply("Provide a valid buy order ID or 'todos'.");
    }

    const order = await getBuyOrderById(orderId);
    if (!order || order.guild_id !== interaction.guild_id) {
        return buildReply(`Buy order #${orderId} does not exist for this guild.`);
    }

    if (order.user_id !== user.id) {
        return buildReply("You can only manage your own buy orders.");
    }

    if (order.status !== "open") {
        const statusLabel = resolveBuyStatusLabel(order.status);
        return buildReply(`Buy order #${order.id} is already ${statusLabel}.`);
    }

    const updated = await updateBuyOrderStatus({ orderId: order.id, status: "fulfilled" });
    if (!updated) {
        return buildReply(`Unable to mark buy order #${order.id} as done. Try again in a moment.`);
    }

    const tradeConfig = await getTradeConfig(interaction.guild_id!);
    const storedUser = await getUserById(user.id);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        interactionUser: user,
        fallbackId: user.id,
    });

    const embed = buildBuyOrderEmbed({ order: updated, userTag });
    const announcementContent = buildBuyOrderAnnouncementContent({
        order: updated,
        userId: updated.user_id,
    });
    const announcementUrl = buildAnnouncementUrl({
        guildId: interaction.guild_id!,
        channelId: updated.announcement_channel_id,
        messageId: updated.announcement_message_id,
    });
    const replyComponents = resolveBuyComponents(updated);

    const metadataError = await clearBuyControls(updated.id);

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
                console.error(`Failed to patch buy order announcement for order #${updated.id}`, error);
            }
        } else {
            missingAnnouncementMetadata = true;
        }
    }

    threadUpdateError = await syncBuyForumThread({ config, tradeConfig, order: updated });

    const responseLines = [
        `Marked buy order #${updated.id} as fulfilled.`,
        announcementUrl ? `Announcement: ${announcementUrl}` : undefined,
        config.allowOffline ? "Offline mode: announcement was not updated." : undefined,
        missingAnnouncementMetadata ? "No stored announcement message to update." : undefined,
        announcementPatchError ? "Warning: Failed to update the buy order announcement." : undefined,
        metadataError ? "Warning: Failed to update stored control metadata." : undefined,
        threadUpdateError ? "Warning: Failed to update the buy order forum thread." : undefined,
    ].filter(Boolean);

    return buildReply(responseLines.join("\n"), replyComponents.length > 0 ? replyComponents : undefined);
}

async function handleDoneAllSubcommand(params: {
    interaction: CommandExecuteContext["interaction"];
    config: CommandExecuteContext["config"];
    user: InteractionUser;
}): Promise<CommandResponse> {
    const { interaction, config, user } = params;
    const guildId = interaction.guild_id!;

    const openOrders = await listBuyOrdersByUser({
        guildId,
        userId: user.id,
        status: "open",
    });

    if (openOrders.length === 0) {
        return buildReply("You have no open buy orders to update.");
    }

    const tradeConfig = await getTradeConfig(guildId);
    const storedUser = await getUserById(user.id);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        interactionUser: user,
        fallbackId: user.id,
    });

    const updatedOrderIds: number[] = [];
    const missingAnnouncementIds: number[] = [];
    const patchFailures: number[] = [];
    const metadataFailures: number[] = [];
    const threadFailures: number[] = [];

    for (const order of openOrders) {
        const updated = await updateBuyOrderStatus({ orderId: order.id, status: "fulfilled" });
        if (!updated) {
            continue;
        }

        updatedOrderIds.push(updated.id);

        const metadataError = await clearBuyControls(updated.id);
        if (metadataError) {
            metadataFailures.push(updated.id);
        }

        if (!config.allowOffline) {
            if (updated.announcement_channel_id && updated.announcement_message_id) {
                try {
                    const embed = buildBuyOrderEmbed({ order: updated, userTag });
                    const announcementContent = buildBuyOrderAnnouncementContent({
                        order: updated,
                        userId: updated.user_id,
                    });

                    await patchTradeAnnouncement({
                        token: config.botToken,
                        channelId: updated.announcement_channel_id,
                        messageId: updated.announcement_message_id,
                        embed,
                        content: announcementContent,
                        components: [],
                    });
                } catch (error) {
                    patchFailures.push(updated.id);
                    console.error(`Failed to patch buy order announcement for order #${updated.id}`, error);
                }
            } else {
                missingAnnouncementIds.push(updated.id);
            }
        }

        if (!config.allowOffline) {
            const threadError = await syncBuyForumThread({ config, tradeConfig, order: updated });
            if (threadError) {
                threadFailures.push(updated.id);
            }
        }
    }

    const lines = [
        `Marked ${updatedOrderIds.length} buy order${updatedOrderIds.length === 1 ? "" : "s"} as fulfilled.`,
        updatedOrderIds.length ? `Orders: ${updatedOrderIds.map((id) => `#${id}`).join(", ")}` : undefined,
        config.allowOffline ? "Offline mode: announcements were not updated." : undefined,
        !config.allowOffline && missingAnnouncementIds.length > 0
            ? `${missingAnnouncementIds.length} order${missingAnnouncementIds.length === 1 ? "" : "s"} did not have announcement metadata stored.`
            : undefined,
        patchFailures.length > 0
            ? `Warning: Failed to update announcements for ${patchFailures.map((id) => `#${id}`).join(", ")}.`
            : undefined,
        metadataFailures.length > 0
            ? `Warning: Failed to update stored control metadata for ${metadataFailures.map((id) => `#${id}`).join(", ")}.`
            : undefined,
        threadFailures.length > 0
            ? `Warning: Failed to update forum threads for ${threadFailures.map((id) => `#${id}`).join(", ")}.`
            : undefined,
    ].filter(Boolean);

    return buildReply(lines.join("\n"));
}

async function handleCancelSubcommand(params: {
    interaction: CommandExecuteContext["interaction"];
    config: CommandExecuteContext["config"];
    options: InteractionDataOption[];
    user: InteractionUser;
}): Promise<CommandResponse> {
    const { interaction, config, options, user } = params;
    const lookup = normalizeOptions(options);
    const orderId = getIntegerOption(lookup, "id");

    if (!orderId || orderId <= 0) {
        return buildReply("Provide a valid buy order ID to cancel.");
    }

    const order = await getBuyOrderById(orderId);
    if (!order || order.guild_id !== interaction.guild_id) {
        return buildReply(`Buy order #${orderId} does not exist for this guild.`);
    }

    if (order.user_id !== user.id) {
        return buildReply("You can only manage your own buy orders.");
    }

    if (order.status !== "open") {
        const statusLabel = resolveBuyStatusLabel(order.status);
        return buildReply(`Buy order #${order.id} is already ${statusLabel}.`);
    }

    const updated = await updateBuyOrderStatus({ orderId: order.id, status: "cancelled" });
    if (!updated) {
        return buildReply("Failed to update the buy order status. Try again in a moment.");
    }

    const tradeConfig = await getTradeConfig(interaction.guild_id!);
    const storedUser = await getUserById(user.id);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        interactionUser: user,
        fallbackId: user.id,
    });

    const embed = buildBuyOrderEmbed({ order: updated, userTag, statusLabel: "Cancelled" });
    const announcementContent = buildBuyOrderAnnouncementContent({
        order: updated,
        userId: updated.user_id,
    });
    const announcementUrl = buildAnnouncementUrl({
        guildId: interaction.guild_id!,
        channelId: updated.announcement_channel_id,
        messageId: updated.announcement_message_id,
    });

    const metadataError = await clearBuyControls(updated.id);

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
                console.error(`Failed to patch buy order announcement for order #${updated.id}`, error);
            }
        } else {
            missingAnnouncementMetadata = true;
        }
    }

    threadUpdateError = await syncBuyForumThread({ config, tradeConfig, order: updated });

    const responseLines = [
        `Buy order #${updated.id} has been cancelled.`,
        announcementUrl ? `Announcement: ${announcementUrl}` : undefined,
        config.allowOffline ? "Offline mode: announcement was not updated." : undefined,
        missingAnnouncementMetadata ? "No stored announcement message to update." : undefined,
        announcementPatchError ? "Warning: Failed to update the buy order announcement." : undefined,
        metadataError ? "Warning: Failed to update stored control metadata." : undefined,
        threadUpdateError ? "Warning: Failed to update the buy order forum thread." : undefined,
    ].filter(Boolean);

    return buildReply(responseLines.join("\n"));
}

const buyCommand: CommandModule = {
    data: commandData,
    async execute({ interaction, config }: CommandExecuteContext): Promise<CommandResponse> {
        if (!interaction.guild_id || !interaction.member) {
            return buildReply("Buy orders can only be managed inside a guild.");
        }

        const user = interaction.member.user ?? interaction.user;
        if (!user) {
            return buildReply("Unable to resolve the user for this interaction.");
        }

        const { name: subcommandName, options } = extractSubcommand(interaction);

        if (!subcommandName || subcommandName === "create") {
            return handleCreateSubcommand({ interaction, config, options, user });
        }

        if (subcommandName === "done") {
            return handleDoneSubcommand({ interaction, config, options, user });
        }

        if (subcommandName === "cancel") {
            return handleCancelSubcommand({ interaction, config, options, user });
        }

        return buildReply("Unsupported subcommand for /buy.");
    },
};

export default buyCommand;
