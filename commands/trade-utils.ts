import type { BuyOrderRecord, TradeRecord, TradeStatus, UserRecord } from "../src/database";
import type { MessageComponent } from "./types";

const numberFormatter = new Intl.NumberFormat("en-US");

export type AnnouncementResult = {
    url: string | null;
    messageId: string | null;
    messageChannelId: string | null;
};

export function resolveStatusLabel(status: TradeStatus): string {
    switch (status) {
        case "open":
            return "Open";
        case "complete":
            return "Closed";
        case "selled":
            return "Sold";
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

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

    if (trade.discount_percent !== null && trade.discounted_auec !== null) {
        const discountedPrice = numberFormatter.format(trade.discounted_auec);
        fields.push({ name: "Original Price", value: `${numberFormatter.format(trade.auec)} aUEC`, inline: true });
        fields.push({ name: "Discount", value: `${trade.discount_percent}%`, inline: true });
        fields.push({ name: "Final Price", value: `${discountedPrice} aUEC`, inline: true });
    } else {
        fields.push({ name: "Price", value: `${numberFormatter.format(trade.auec)} aUEC`, inline: true });
    }

    fields.push({ name: "Stock", value: `${trade.stock}`, inline: true });
    fields.push({ name: "Trade ID", value: `#${trade.id}`, inline: true });

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

export function buildTradeAnnouncementContent(params: {
    trade: TradeRecord;
    userId: string;
}): string {
    const base = `New trade from <@${params.userId}>`;

    if (params.trade.discount_percent !== null && params.trade.discounted_auec !== null) {
        return `${base} — ${numberFormatter.format(params.trade.discounted_auec)} aUEC (${params.trade.discount_percent}% off)`;
    }

    return `${base} — ${numberFormatter.format(params.trade.auec)} aUEC`;
}

export function buildBuyOrderEmbed(params: {
    order: BuyOrderRecord;
    userTag: string;
}): Record<string, unknown> {
    const { order, userTag } = params;

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
        { name: "Price", value: `${numberFormatter.format(order.price)} aUEC`, inline: true },
        { name: "Order ID", value: `#${order.id}`, inline: true },
    ];

    if (order.amount !== null) {
        fields.splice(1, 0, { name: "Desired Amount", value: `${order.amount}`, inline: true });
    }

    const embed: Record<string, unknown> = {
        title: `Looking to buy: ${order.item}`,
        color: 0x1d4ed8,
        fields,
        timestamp: new Date(order.created_at).toISOString(),
        footer: { text: `Buyer: ${userTag}` },
    };

    if (order.attachment_url) {
        embed.image = { url: order.attachment_url };
    }

    return embed;
}

export function buildBuyOrderAnnouncementContent(params: {
    order: BuyOrderRecord;
    userId: string;
}): string {
    const base = `New buy order from <@${params.userId}>`;

    if (params.order.amount !== null) {
        return `${base} — Offering ${numberFormatter.format(params.order.price)} aUEC for ${params.order.amount} unit(s)`;
    }

    return `${base} — Offering ${numberFormatter.format(params.order.price)} aUEC`;
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

export async function deliverTradeAnnouncement(params: {
    token: string;
    guildId: string;
    channelId: string;
    channelType: "text" | "forum";
    content: string;
    threadName: string;
    embed: Record<string, unknown>;
    userId: string;
    appliedTags?: string[];
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

    const threadPayload: Record<string, unknown> = {
        name: params.threadName,
        message: {
            content: params.content,
            embeds: [params.embed],
            allowed_mentions: allowedMentions,
        },
    };

    if (params.appliedTags && params.appliedTags.length > 0) {
        threadPayload.applied_tags = params.appliedTags;
    }

    const response = await fetch(`https://discord.com/api/v10/channels/${params.channelId}/threads`, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(threadPayload),
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
