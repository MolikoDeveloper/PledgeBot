import { InteractionResponseFlags, InteractionResponseType } from "discord-interactions";

import {
    getTradeById,
    getTradeConfig,
    getUserById,
    reduceTradeStock,
    updateTradeAnnouncementMetadata,
    updateTradeStatus,
    type TradeRecord,
} from "../src/database";
import type { AppConfig } from "../src/config";
import {
    buildAnnouncementUrl,
    buildSellThreadName,
    buildTradeAnnouncementContent,
    buildTradeEmbed,
    patchTradeAnnouncement,
    resolveForumThreadId,
    resolveStatusLabel,
    resolveUserTag,
    shouldArchiveSellThread,
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

async function clearTradeControls(tradeId: number): Promise<Error | null> {
    try {
        await updateTradeAnnouncementMetadata({
            tradeId,
            doneOneButtonId: null,
            doneAllButtonId: null,
            cancelButtonId: null,
        });
        return null;
    } catch (error) {
        const err = error instanceof Error ? error : new Error("Unknown metadata update failure");
        console.error(`Failed to clear trade component metadata for trade #${tradeId}`, error);
        return err;
    }
}

function buildActiveComponents(trade: TradeRecord): MessageComponent[] {
    if (trade.status !== "open" || trade.stock <= 0) {
        return [];
    }

    if (!trade.done_one_button_custom_id || !trade.cancel_button_custom_id) {
        return [];
    }

    const buttons: MessageComponent["components"] = [
        {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SUCCESS,
            label: "Done 1 item",
            custom_id: trade.done_one_button_custom_id,
        },
    ];

    if (trade.stock > 1 && trade.done_all_button_custom_id) {
        buttons.push({
            type: ComponentType.BUTTON,
            style: ButtonStyle.PRIMARY,
            label: "Done all",
            custom_id: trade.done_all_button_custom_id,
        });
    }

    buttons.push({
        type: ComponentType.BUTTON,
        style: ButtonStyle.DANGER,
        label: "Cancel",
        custom_id: trade.cancel_button_custom_id,
    });

    return [
        {
            type: ComponentType.ACTION_ROW,
            components: buttons,
        },
    ];
}

async function handleDoneAction(params: {
    interaction: MessageComponentInteraction;
    config: AppConfig;
    tradeConfig: Awaited<ReturnType<typeof getTradeConfig>>;
    trade: Awaited<ReturnType<typeof getTradeById>>;
    customId: string;
    userId: string;
    mode: "one" | "all";
}): Promise<CommandResponse> {
    const { interaction, config, tradeConfig, trade, customId, userId, mode } = params;

    if (!trade) {
        return buildEphemeralResponse("Trade not found.");
    }

    if (mode === "all" && !trade.done_all_button_custom_id) {
        return buildEphemeralResponse("This trade action is no longer valid.");
    }

    if (mode === "one" && !trade.done_one_button_custom_id) {
        return buildEphemeralResponse("This trade action is no longer valid.");
    }

    const expectedCustomId = mode === "all" ? trade.done_all_button_custom_id : trade.done_one_button_custom_id;
    if (expectedCustomId && expectedCustomId !== customId) {
        return buildEphemeralResponse("This trade action is no longer valid.");
    }

    if (trade.status !== "open") {
        const statusLabel = resolveStatusLabel(trade.status);
        return buildEphemeralResponse(`Trade #${trade.id} is already ${statusLabel}.`);
    }

    if (trade.stock <= 0) {
        return buildEphemeralResponse(`Trade #${trade.id} has no remaining stock.`);
    }

    const amount = mode === "all" ? trade.stock : 1;
    const updated = await reduceTradeStock({ tradeId: trade.id, amount });
    if (!updated) {
        return buildEphemeralResponse(
            `Unable to mark ${amount === 1 ? "1 item" : `${amount} items`} as done. Check the available stock and try again.`,
        );
    }

    const metadataError = updated.status !== "open" ? await clearTradeControls(trade.id) : null;

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
                const embed = buildTradeEmbed({ trade: updated, userTag });
                const components = updated.status === "open" ? buildActiveComponents(updated) : [];
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
                announcementPatchError =
                    error instanceof Error ? error : new Error("Unknown announcement update failure.");
                console.error(`Failed to patch trade announcement for trade #${trade.id}`, error);
            }
        } else {
            missingAnnouncementMetadata = true;
        }
    }

    if (!config.allowOffline) {
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
                console.error(`Failed to update forum thread for trade #${trade.id}`, error);
            }
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
        threadUpdateError ? "Warning: Failed to update the trade forum thread." : undefined,
    ].filter(Boolean);

    return buildEphemeralResponse(responseLines.join("\n"));
}

async function handleCancelAction(params: {
    interaction: MessageComponentInteraction;
    config: AppConfig;
    tradeConfig: Awaited<ReturnType<typeof getTradeConfig>>;
    trade: Awaited<ReturnType<typeof getTradeById>>;
    customId: string;
    userId: string;
}): Promise<CommandResponse> {
    const { interaction, config, tradeConfig, trade, customId, userId } = params;

    if (!trade) {
        return buildEphemeralResponse("Trade not found.");
    }

    if (trade.cancel_button_custom_id && trade.cancel_button_custom_id !== customId) {
        return buildEphemeralResponse("This trade action is no longer valid.");
    }

    if (trade.status === "cancelled") {
        return buildEphemeralResponse(`Trade #${trade.id} is already cancelled.`);
    }

    if (trade.status !== "open") {
        const statusLabel = resolveStatusLabel(trade.status);
        return buildEphemeralResponse(`Trade #${trade.id} is already ${statusLabel}.`);
    }

    const updated = await updateTradeStatus({ tradeId: trade.id, status: "cancelled" });
    if (!updated) {
        return buildEphemeralResponse("Failed to update the trade status. Try again in a moment.");
    }

    const metadataError = await clearTradeControls(trade.id);

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
                const embed = buildTradeEmbed({
                    trade: updated,
                    userTag,
                    statusLabel: "Cancelled",
                });
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
                    components: [],
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

    if (!config.allowOffline) {
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
                console.error(`Failed to update forum thread for trade #${trade.id}`, error);
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

    return buildEphemeralResponse(responseLines.join("\n"));
}

export async function handleTradeComponent(params: {
    interaction: MessageComponentInteraction;
    config: AppConfig;
}): Promise<CommandResponse> {
    const { interaction, config } = params;

    if (!interaction.data || !interaction.data.custom_id) {
        return buildEphemeralResponse("Unsupported component interaction.");
    }

    if (!interaction.guild_id) {
        return buildEphemeralResponse("Trades can only be managed inside a guild.");
    }

    const userId = extractUserId(interaction);
    if (!userId) {
        return buildEphemeralResponse("Unable to determine the user for this interaction.");
    }

    const parts = interaction.data.custom_id.split(":");
    if (parts.length < 3 || parts[0] !== "trade") {
        return buildEphemeralResponse("Unsupported trade component.");
    }

    const tradeId = Number.parseInt(parts[1] ?? "", 10);
    const action = (parts[2] ?? "").toLowerCase();
    const scope = (parts[3] ?? "").toLowerCase();

    if (!Number.isInteger(tradeId) || tradeId <= 0) {
        return buildEphemeralResponse("Invalid trade identifier.");
    }

    const trade = await getTradeById(tradeId);
    if (!trade || trade.guild_id !== interaction.guild_id) {
        return buildEphemeralResponse(`Trade #${tradeId} does not exist for this guild.`);
    }

    if (trade.user_id !== userId) {
        return buildEphemeralResponse("Only the seller can manage this trade.");
    }

    const tradeConfig = await getTradeConfig(interaction.guild_id);

    if (action === "done") {
        const mode: "one" | "all" = scope === "all" ? "all" : "one";
        return handleDoneAction({
            interaction,
            config,
            tradeConfig,
            trade,
            customId: interaction.data.custom_id,
            userId,
            mode,
        });
    }

    if (action === "cancel") {
        return handleCancelAction({
            interaction,
            config,
            tradeConfig,
            trade,
            customId: interaction.data.custom_id,
            userId,
        });
    }

    return buildEphemeralResponse("Unsupported trade component action.");
}
