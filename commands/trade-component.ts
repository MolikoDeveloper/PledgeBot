import { InteractionResponseFlags, InteractionResponseType } from "discord-interactions";

import {
    getTradeById,
    getUserById,
    updateTradeAnnouncementMetadata,
    updateTradeStatus,
} from "../src/database";
import type { AppConfig } from "../src/config";
import {
    buildAnnouncementUrl,
    buildTradeEmbed,
    patchTradeAnnouncement,
    resolveStatusLabel,
    resolveUserTag,
} from "./trade-utils";
import type { CommandResponse, MessageComponentInteraction } from "./types";

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

async function updateAnnouncementControls(tradeId: number): Promise<Error | null> {
    try {
        await updateTradeAnnouncementMetadata({
            tradeId,
            closeButtonId: null,
            cancelButtonId: null,
        });
        return null;
    } catch (error) {
        const err = error instanceof Error ? error : new Error("Unknown metadata update failure");
        console.error(`Failed to clear trade component metadata for trade #${tradeId}`, error);
        return err;
    }
}

async function handleCloseAction(params: {
    interaction: MessageComponentInteraction;
    config: AppConfig;
    trade: Awaited<ReturnType<typeof getTradeById>>;
    customId: string;
    userId: string;
}): Promise<CommandResponse> {
    const { interaction, config, trade, customId, userId } = params;

    if (!trade) {
        return buildEphemeralResponse("Trade not found.");
    }

    if (trade.close_button_custom_id && trade.close_button_custom_id !== customId) {
        return buildEphemeralResponse("This trade action is no longer valid.");
    }

    if (trade.status !== "open") {
        const statusLabel = resolveStatusLabel(trade.status);
        return buildEphemeralResponse(`Trade #${trade.id} is already ${statusLabel}.`);
    }

    const updated = await updateTradeStatus({ tradeId: trade.id, status: "complete" });
    if (!updated) {
        return buildEphemeralResponse("Failed to update the trade status. Try again in a moment.");
    }

    const metadataError = await updateAnnouncementControls(trade.id);

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
                announcementPatchError =
                    error instanceof Error ? error : new Error("Unknown announcement update failure.");
                console.error(`Failed to patch trade announcement for trade #${trade.id}`, error);
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
        metadataError ? "Warning: Failed to update stored control metadata." : undefined,
    ].filter(Boolean);

    return buildEphemeralResponse(responseLines.join("\n"));
}

async function handleCancelAction(params: {
    interaction: MessageComponentInteraction;
    config: AppConfig;
    trade: Awaited<ReturnType<typeof getTradeById>>;
    customId: string;
    userId: string;
}): Promise<CommandResponse> {
    const { interaction, config, trade, customId, userId } = params;

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

    const metadataError = await updateAnnouncementControls(trade.id);

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

    if (!config.allowOffline) {
        if (updated.announcement_channel_id && updated.announcement_message_id) {
            try {
                const embed = buildTradeEmbed({
                    trade: updated,
                    userTag,
                    statusLabel: "Cancelled",
                });

                await patchTradeAnnouncement({
                    token: config.botToken,
                    channelId: updated.announcement_channel_id,
                    messageId: updated.announcement_message_id,
                    embed,
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

    const responseLines = [
        `Trade #${updated.id} has been cancelled.`,
        announcementUrl ? `Announcement: ${announcementUrl}` : undefined,
        config.allowOffline ? "Offline mode: announcement was not updated." : undefined,
        missingAnnouncementMetadata ? "No stored announcement message to update." : undefined,
        announcementPatchError ? "Warning: Failed to update the trade announcement." : undefined,
        metadataError ? "Warning: Failed to update stored control metadata." : undefined,
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

    const match = /^trade:(\d+):([a-zA-Z]+)$/.exec(interaction.data.custom_id);
    if (!match) {
        return buildEphemeralResponse("Unsupported trade component.");
    }

    const tradeId = Number.parseInt(match[1], 10);
    const action = match[2].toLowerCase();

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

    if (action === "close") {
        return handleCloseAction({ interaction, config, trade, customId: interaction.data.custom_id, userId });
    }

    if (action === "cancel") {
        return handleCancelAction({ interaction, config, trade, customId: interaction.data.custom_id, userId });
    }

    return buildEphemeralResponse("Unsupported trade component action.");
}
