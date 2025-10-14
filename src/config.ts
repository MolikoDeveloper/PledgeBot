import { join } from "path";

const BOT_TOKEN = process.env.D_bot_token;
const CLIENT_ID = process.env.D_client_id;
const PUBLIC_KEY = process.env.D_public_key;

if (!BOT_TOKEN) {
    throw new Error("Environment variable D_bot_token is required");
}

if (!CLIENT_ID) {
    throw new Error("Environment variable D_client_id is required");
}

if (!PUBLIC_KEY) {
    throw new Error("Environment variable D_public_key is required");
}

const projectRoot = process.cwd();
const defaultDatabasePath = join(projectRoot, "data", "pledgebot.sqlite");
const defaultDatabaseUrl = `file:${defaultDatabasePath}`;

if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = defaultDatabaseUrl;
}

export const config = {
    botToken: BOT_TOKEN,
    clientId: CLIENT_ID,
    publicKey: PUBLIC_KEY,
    databaseUrl: process.env.DATABASE_URL,
    guildIds: (process.env.D_guild_ids ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    allowOffline: process.env.DISCORD_ALLOW_OFFLINE === "true",
};

export type AppConfig = typeof config;
