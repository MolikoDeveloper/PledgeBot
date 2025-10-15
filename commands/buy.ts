import {
    InteractionResponseFlags,
    InteractionResponseType,
} from "discord-interactions";

import {
    createBuyOrder,
    getTradeConfig,
    recordGuild,
    recordUser,
    updateBuyOrderAnnouncementMetadata,
} from "../src/database";
import {
    ApplicationCommandOptionType,
    type CommandData,
    type CommandExecuteContext,
    type CommandModule,
    type CommandResponse,
    type InteractionAttachment,
    type InteractionDataOption,
} from "./types";
import {
    buildAnnouncementUrl,
    buildBuyOrderAnnouncementContent,
    buildBuyOrderEmbed,
    buildBuyThreadName,
    deliverTradeAnnouncement,
    resolveUserTag,
    type AnnouncementResult,
} from "./trade-utils";

const commandData: CommandData = {
    name: "buy",
    description: "Publish a buy order.",
    dm_permission: false,
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
};

function buildReply(content: string): CommandResponse {
    return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
            content,
            flags: InteractionResponseFlags.EPHEMERAL,
        },
    };
}

function normalizeOptions(options: InteractionDataOption[] | undefined): Record<string, InteractionDataOption> {
    if (!options) {
        return {};
    }

    return options.reduce<Record<string, InteractionDataOption>>((acc, option) => {
        acc[option.name] = option;
        return acc;
    }, {});
}

function getStringOption(lookup: Record<string, InteractionDataOption>, name: string): string | null {
    const option = lookup[name];
    if (!option || typeof option.value !== "string") {
        return null;
    }
    return option.value;
}

function getIntegerOption(lookup: Record<string, InteractionDataOption>, name: string): number | null {
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

const buyCommand: CommandModule = {
    data: commandData,
    async execute({ interaction, config }: CommandExecuteContext): Promise<CommandResponse> {
        const guildId = interaction.guild_id;
        if (!guildId) {
            return buildReply("This command can only be used within a server.");
        }

        const user = interaction.member?.user ?? interaction.user;
        if (!user) {
            return buildReply("Unable to resolve the user for this interaction.");
        }

        const options = interaction.data.options ?? [];
        const lookup = normalizeOptions(options);
        const itemOption = getStringOption(lookup, "item");
        const priceOption = getIntegerOption(lookup, "price");
        const amountOption = getIntegerOption(lookup, "amount");
        const attachmentId = getStringOption(lookup, "attachment");
        const attachment = attachmentId
            ? interaction.data.resolved?.attachments?.[attachmentId] ?? null
            : null;
        const attachmentUrl = resolveImageUrl(attachment);

        const item = itemOption?.trim();
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

        const userTag = resolveUserTag({
            interactionUser: user,
            fallbackId: user.id,
        });

        const embed = buildBuyOrderEmbed({
            order,
            userTag,
        });
        const content = buildBuyOrderAnnouncementContent({ order, userId: user.id });
        const threadName = buildBuyThreadName(order);

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
                    channelId: tradeConfig.tradeChannelId,
                    channelType: tradeConfig.tradeChannelType,
                    content,
                    threadName,
                    embed,
                    userId: user.id,
                    appliedTags: appliedForumTags,
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
        ].filter(Boolean);

        return buildReply(responseLines.join("\n"));
    },
};

export default buyCommand;
