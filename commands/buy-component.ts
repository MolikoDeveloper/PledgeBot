import { InteractionResponseFlags, InteractionResponseType } from "discord-interactions";

import {
    getBuyOrderById,
    getTradeConfig,
    getUserById,
    updateBuyOrderAnnouncementMetadata,
    updateBuyOrderStatus,
    type BuyOrderRecord,
} from "../src/database";
import type { AppConfig } from "../src/config";
import {
    buildAnnouncementUrl,
    buildBuyOrderAnnouncementContent,
    buildBuyOrderEmbed,
    buildBuyThreadName,
    patchTradeAnnouncement,
    resolveBuyStatusLabel,
    resolveForumThreadId,
    resolveUserTag,
    shouldArchiveBuyThread,
    updateForumThread,
} from "./trade-utils";
import type { CommandResponse, MessageComponent, MessageComponentInteraction } from "./types";
import { ButtonStyle, ComponentType } from "./types";

function buildEphemeralResponse(content: string): CommandResponse {
    return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
            content,
            flags: InteractionResponseFlags.EPHEMERAL,
        },
    };
}

function extractUserId(interaction: MessageComponentInteraction): string | null {
    return interaction.member?.user?.id ?? interaction.user?.id ?? null;
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

function buildActiveComponents(order: BuyOrderRecord): MessageComponent[] {
    if (order.status !== "open") {
        return [];
    }

    if (!order.done_button_custom_id || !order.cancel_button_custom_id) {
        return [];
    }

    return [
        {
            type: ComponentType.ACTION_ROW,
            components: [
                {
                    type: ComponentType.BUTTON,
                    style: ButtonStyle.SUCCESS,
                    label: "Mark done",
                    custom_id: order.done_button_custom_id,
                },
                {
                    type: ComponentType.BUTTON,
                    style: ButtonStyle.DANGER,
                    label: "Cancel",
                    custom_id: order.cancel_button_custom_id,
                },
            ],
        },
    ];
}

async function syncBuyForumThread(params: {
    config: AppConfig;
    tradeConfig: Awaited<ReturnType<typeof getTradeConfig>>;
    order: BuyOrderRecord;
}): Promise<Error | null> {
    if (params.config.allowOffline) {
        return null;
    }

    const threadId = resolveForumThreadId({
        announcementChannelId: params.order.announcement_channel_id,
        tradeChannelId: params.tradeConfig.tradeChannelId,
        tradeChannelType: params.tradeConfig.tradeChannelType,
    });

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

async function handleDoneAction(params: {
    interaction: MessageComponentInteraction;
    config: AppConfig;
    tradeConfig: Awaited<ReturnType<typeof getTradeConfig>>;
    order: BuyOrderRecord | null;
    customId: string;
    userId: string;
}): Promise<CommandResponse> {
    const { interaction, config, tradeConfig, order, customId, userId } = params;

    if (!order) {
        return buildEphemeralResponse("Buy order not found.");
    }

    if (order.done_button_custom_id && order.done_button_custom_id !== customId) {
        return buildEphemeralResponse("This buy order action is no longer valid.");
    }

    if (order.status === "fulfilled") {
        return buildEphemeralResponse(`Buy order #${order.id} is already fulfilled.`);
    }

    if (order.status !== "open") {
        const statusLabel = resolveBuyStatusLabel(order.status);
        return buildEphemeralResponse(`Buy order #${order.id} is already ${statusLabel}.`);
    }

    const updated = await updateBuyOrderStatus({ orderId: order.id, status: "fulfilled" });
    if (!updated) {
        return buildEphemeralResponse("Failed to update the buy order. Try again in a moment.");
    }

    const metadataError = await clearBuyControls(order.id);

    const storedUser = await getUserById(userId);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        interactionUser: interaction.member?.user ?? interaction.user ?? null,
        fallbackId: userId,
    });

    const announcementUrl = buildAnnouncementUrl({
        guildId: interaction.guild_id!,
        channelId: updated.announcement_channel_id,
        messageId: updated.announcement_message_id,
    });

    let announcementPatchError: Error | null = null;
    let missingAnnouncementMetadata = false;
    let threadUpdateError: Error | null = null;

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
                announcementPatchError =
                    error instanceof Error ? error : new Error("Unknown announcement update failure.");
                console.error(`Failed to patch buy order announcement for order #${order.id}`, error);
            }
        } else {
            missingAnnouncementMetadata = true;
        }
    }

    threadUpdateError = await syncBuyForumThread({ config, tradeConfig, order: updated });

    const responseLines = [
        `Buy order #${updated.id} marked as fulfilled.`,
        announcementUrl ? `Announcement: ${announcementUrl}` : undefined,
        config.allowOffline ? "Offline mode: announcement was not updated." : undefined,
        missingAnnouncementMetadata ? "No stored announcement message to update." : undefined,
        announcementPatchError ? "Warning: Failed to update the buy order announcement." : undefined,
        metadataError ? "Warning: Failed to update stored control metadata." : undefined,
        threadUpdateError ? "Warning: Failed to update the buy order forum thread." : undefined,
    ].filter(Boolean);

    return buildEphemeralResponse(responseLines.join("\n"));
}

async function handleCancelAction(params: {
    interaction: MessageComponentInteraction;
    config: AppConfig;
    tradeConfig: Awaited<ReturnType<typeof getTradeConfig>>;
    order: BuyOrderRecord | null;
    customId: string;
    userId: string;
}): Promise<CommandResponse> {
    const { interaction, config, tradeConfig, order, customId, userId } = params;

    if (!order) {
        return buildEphemeralResponse("Buy order not found.");
    }

    if (order.cancel_button_custom_id && order.cancel_button_custom_id !== customId) {
        return buildEphemeralResponse("This buy order action is no longer valid.");
    }

    if (order.status === "cancelled") {
        return buildEphemeralResponse(`Buy order #${order.id} is already cancelled.`);
    }

    if (order.status !== "open") {
        const statusLabel = resolveBuyStatusLabel(order.status);
        return buildEphemeralResponse(`Buy order #${order.id} is already ${statusLabel}.`);
    }

    const updated = await updateBuyOrderStatus({ orderId: order.id, status: "cancelled" });
    if (!updated) {
        return buildEphemeralResponse("Failed to update the buy order status. Try again in a moment.");
    }

    const metadataError = await clearBuyControls(order.id);

    const storedUser = await getUserById(userId);
    const userTag = resolveUserTag({
        userRecord: storedUser,
        interactionUser: interaction.member?.user ?? interaction.user ?? null,
        fallbackId: userId,
    });

    const announcementUrl = buildAnnouncementUrl({
        guildId: interaction.guild_id!,
        channelId: updated.announcement_channel_id,
        messageId: updated.announcement_message_id,
    });

    let announcementPatchError: Error | null = null;
    let missingAnnouncementMetadata = false;
    let threadUpdateError: Error | null = null;

    if (!config.allowOffline) {
        if (updated.announcement_channel_id && updated.announcement_message_id) {
            try {
                const embed = buildBuyOrderEmbed({ order: updated, userTag, statusLabel: "Cancelled" });
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
                announcementPatchError =
                    error instanceof Error ? error : new Error("Unknown announcement update failure.");
                console.error(`Failed to patch buy order announcement for order #${order.id}`, error);
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

    return buildEphemeralResponse(responseLines.join("\n"));
}

export async function handleBuyComponent(params: {
    interaction: MessageComponentInteraction;
    config: AppConfig;
}): Promise<CommandResponse> {
    const { interaction, config } = params;

    if (!interaction.data || !interaction.data.custom_id) {
        return buildEphemeralResponse("Unsupported component interaction.");
    }

    if (!interaction.guild_id) {
        return buildEphemeralResponse("Buy orders can only be managed inside a guild.");
    }

    const userId = extractUserId(interaction);
    if (!userId) {
        return buildEphemeralResponse("Unable to determine the user for this interaction.");
    }

    const parts = interaction.data.custom_id.split(":");
    if (parts.length < 3 || parts[0] !== "buy") {
        return buildEphemeralResponse("Unsupported buy order component.");
    }

    const orderId = Number.parseInt(parts[1] ?? "", 10);
    const action = (parts[2] ?? "").toLowerCase();

    if (!Number.isInteger(orderId) || orderId <= 0) {
        return buildEphemeralResponse("Invalid buy order identifier.");
    }

    const order = await getBuyOrderById(orderId);
    if (!order || order.guild_id !== interaction.guild_id) {
        return buildEphemeralResponse(`Buy order #${orderId} does not exist for this guild.`);
    }

    if (order.user_id !== userId) {
        return buildEphemeralResponse("Only the buyer can manage this order.");
    }

    const tradeConfig = await getTradeConfig(interaction.guild_id);

    if (action === "done") {
        return handleDoneAction({
            interaction,
            config,
            tradeConfig,
            order,
            customId: interaction.data.custom_id,
            userId,
        });
    }

    if (action === "cancel") {
        return handleCancelAction({
            interaction,
            config,
            tradeConfig,
            order,
            customId: interaction.data.custom_id,
            userId,
        });
    }

    return buildEphemeralResponse("Unsupported buy order component action.");
}
