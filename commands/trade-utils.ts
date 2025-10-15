import type { TradeRecord, TradeStatus, UserRecord } from "../src/database";
import type { MessageComponent } from "./types";

const numberFormatter = new Intl.NumberFormat("en-US");

export function resolveStatusLabel(status: TradeStatus): string {
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

export function resolveUserTag(params: {
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

export function buildTradeEmbed(params: {
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

export function buildAnnouncementUrl(params: {
    guildId: string;
    channelId: string | null;
    messageId: string | null;
}): string | null {
    if (!params.channelId || !params.messageId) {
        return null;
    }

    return `https://discord.com/channels/${params.guildId}/${params.channelId}/${params.messageId}`;
}

export async function patchTradeAnnouncement(params: {
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
