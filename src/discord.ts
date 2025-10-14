import { config } from "./config";

interface GuildMetadata {
    id: string;
    name: string;
}

const guildCache = new Map<string, GuildMetadata>();

export async function fetchGuildMetadata(guildId: string): Promise<GuildMetadata | null> {
    const cached = guildCache.get(guildId);
    if (cached) {
        return cached;
    }

    if (config.allowOffline) {
        return null;
    }

    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
        headers: {
            Authorization: `Bot ${config.botToken}`,
        },
    });

    if (!response.ok) {
        let detail: string;
        try {
            detail = JSON.stringify(await response.json());
        } catch {
            detail = await response.text();
        }
        console.error(`Failed to fetch guild ${guildId}: ${response.status} ${response.statusText} - ${detail}`);
        return null;
    }

    const data = (await response.json()) as { id?: string; name?: string };
    if (!data || typeof data.name !== "string") {
        console.error(`Guild metadata response missing name for guild ${guildId}`);
        return null;
    }

    const metadata: GuildMetadata = {
        id: data.id ?? guildId,
        name: data.name,
    };
    guildCache.set(guildId, metadata);
    return metadata;
}
