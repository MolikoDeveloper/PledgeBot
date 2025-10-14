import { Database } from "bun:sqlite";
import { fetchGuildMetadata } from "./discord";

const db = new Database("./trade.sqlite", { create: true });

type QueryValue = string | number | bigint | boolean | null;

type QueryParams = Record<string, QueryValue | undefined>;

type NormalizedParams = Record<string, QueryValue>;

const PARAM_PREFIXES = new Set([":", "@", "$"]);

function normalizeParams(params?: QueryParams): NormalizedParams | undefined {
    if (!params) {
        return undefined;
    }

    const normalized: NormalizedParams = {};

    for (const [key, rawValue] of Object.entries(params)) {
        if (rawValue === undefined) {
            continue;
        }

        const normalizedKey = PARAM_PREFIXES.has(key[0] ?? "") ? key : `:${key}`;
        normalized[normalizedKey] = rawValue;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function run(sql: string, params: QueryParams = {}): void {
    const stmt = db.prepare(sql);
    const normalized = normalizeParams(params);
    normalized ? stmt.run(normalized) : stmt.run();
}

function get<T>(sql: string, params: QueryParams = {}): T | null {
    const stmt = db.prepare(sql);
    const normalized = normalizeParams(params);
    const result = normalized ? stmt.get(normalized) : stmt.get();
    return (result ?? null) as T | null;
}

function all<T>(sql: string, params: QueryParams = {}): T[] {
    const stmt = db.prepare(sql);
    const normalized = normalizeParams(params);
    return (normalized ? stmt.all(normalized) : stmt.all()) as T[];
}

function hasGuildRecord(guildId: string): boolean {
    const row = get<{ id: string }>(
        `SELECT id FROM guilds WHERE id = :guildId LIMIT 1`,
        { guildId },
    );
    return row !== null;
}

async function ensureGuildRecord(guildId: string): Promise<void> {
    if (hasGuildRecord(guildId)) {
        return;
    }

    const metadata = await fetchGuildMetadata(guildId);
    await recordGuild(guildId, metadata?.name ?? guildId);
}

export const trade_status = [
    "open",
    "matched",
    "escrow",
    "complete",
    "cancelled",
    "expired",
] as const;

export type TradeStatus = (typeof trade_status)[number];

export type TradeRecord = {
    id: number;
    guild_id: string;
    user_id: string;
    title: string;
    auec: number;
    stock: number;
    image_url: string | null;
    announcement_channel_id: string | null;
    announcement_message_id: string | null;
    close_button_custom_id: string | null;
    cancel_button_custom_id: string | null;
    status: TradeStatus;
    reason: string | null;
    created_at: string;
    updated_at: string;
};

export type UserRecord = {
    id: string;
    username: string;
    display_name: string | null;
    discriminator: string | null;
    created_at: string;
    updated_at: string;
};

export async function initializeDatabase(): Promise<void> {
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA foreign_keys = ON;");

    db.run(`
        CREATE TABLE IF NOT EXISTS guilds (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            admin_role_id TEXT,
            trade_channel_id TEXT,
            trade_channel_type TEXT CHECK (trade_channel_type IN ('forum','text')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS guild_roles (
            guild_id TEXT NOT NULL,
            role_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (guild_id, role_id),
            FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            display_name TEXT,
            discriminator TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            auec INTEGER NOT NULL,
            stock INTEGER NOT NULL DEFAULT 1,
            image_url TEXT,
            announcement_channel_id TEXT,
            announcement_message_id TEXT,
            close_button_custom_id TEXT,
            cancel_button_custom_id TEXT,
            status TEXT NOT NULL CHECK (status IN ('open','matched','escrow','complete','cancelled','expired')),
            reason TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS command_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT,
            user_id TEXT,
            command_name TEXT NOT NULL,
            options_json TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);

    const tradeColumns = db.prepare(`PRAGMA table_info(trades)`).all() as { name: string }[];
    const tradeColumnNames = new Set(tradeColumns.map((column) => column.name));

    if (!tradeColumnNames.has("announcement_channel_id")) {
        db.run(`ALTER TABLE trades ADD COLUMN announcement_channel_id TEXT`);
    }

    if (!tradeColumnNames.has("announcement_message_id")) {
        db.run(`ALTER TABLE trades ADD COLUMN announcement_message_id TEXT`);
    }

    if (!tradeColumnNames.has("close_button_custom_id")) {
        db.run(`ALTER TABLE trades ADD COLUMN close_button_custom_id TEXT`);
    }

    if (!tradeColumnNames.has("cancel_button_custom_id")) {
        db.run(`ALTER TABLE trades ADD COLUMN cancel_button_custom_id TEXT`);
    }
}

export async function recordGuild(guildId: string, name: string | null | undefined, adminRoleId?: string | null): Promise<void> {
    const resolvedName = typeof name === "string" && name.trim().length > 0 ? name : guildId;
    
    run(
        `
        INSERT INTO guilds (id, name, admin_role_id)
        VALUES (:id, :name, :adminRoleId)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            admin_role_id = COALESCE(excluded.admin_role_id, guilds.admin_role_id),
            updated_at = datetime('now')
        `,
        {
            id: guildId,
            name: resolvedName,
            adminRoleId: adminRoleId ?? null,
        },
    );
}

export async function recordUser(params: {
    id: string;
    username: string;
    displayName?: string | null;
    discriminator?: string | null;
}): Promise<void> {
    run(
        `
        INSERT INTO users (id, username, display_name, discriminator)
        VALUES (:id, :username, :displayName, :discriminator)
        ON CONFLICT(id) DO UPDATE SET
            username = excluded.username,
            display_name = COALESCE(excluded.display_name, users.display_name),
            discriminator = COALESCE(excluded.discriminator, users.discriminator),
            updated_at = datetime('now')
        `,
        {
            id: params.id,
            username: params.username,
            displayName: params.displayName ?? null,
            discriminator: params.discriminator ?? null,
        },
    );
}

export async function logCommandUsage(params: {
    guildId?: string | null;
    userId?: string | null;
    commandName: string;
    options: Record<string, unknown>;
}): Promise<void> {
    run(
        `
        INSERT INTO command_history (guild_id, user_id, command_name, options_json)
        VALUES (:guildId, :userId, :commandName, :optionsJson)
        `,
        {
            guildId: params.guildId ?? null,
            userId: params.userId ?? null,
            commandName: params.commandName,
            optionsJson: JSON.stringify(params.options),
        },
    );
}

export async function setTradeChannel(params: {
    guildId: string;
    guildName?: string;
    channelId: string;
    channelType: 'forum' | 'text';
}): Promise<void> {
    let guildName = params.guildName;
    if (!guildName) {
        const metadata = await fetchGuildMetadata(params.guildId);
        guildName = metadata?.name ?? params.guildId;
    }

    await recordGuild(params.guildId, guildName);

    run(
        `
        UPDATE guilds
        SET trade_channel_id = :channelId,
            trade_channel_type = :channelType,
            updated_at = datetime('now')
        WHERE id = :guildId
        `,
        {
            guildId: params.guildId,
            channelId: params.channelId,
            channelType: params.channelType,
        },
    );

    run(
        `
        INSERT INTO guilds (id, name, trade_channel_id, trade_channel_type)
        SELECT :guildId, :guildName, :channelId, :channelType
        WHERE NOT EXISTS (SELECT 1 FROM guilds WHERE id = :guildId)
        `,
        {
            guildId: params.guildId,
            guildName,
            channelId: params.channelId,
            channelType: params.channelType,
        },
    );
}

export async function updateAdminRole(guildId: string, roleId: string | null, guildName?: string): Promise<void> {
    if (guildName) {
        await recordGuild(guildId, guildName, roleId);
    }

    run(
        `
        UPDATE guilds SET admin_role_id = :roleId, updated_at = datetime('now') WHERE id = :guildId
        `,
        {
            guildId,
            roleId,
        },
    );

    run(
        `
        INSERT INTO guilds (id, name, admin_role_id)
        SELECT :guildId, :guildName, :roleId
        WHERE NOT EXISTS (SELECT 1 FROM guilds WHERE id = :guildId)
        `,
        {
            guildId,
            guildName: guildName ?? guildId,
            roleId,
        },
    );
}

export async function addTradeRole(guildId: string, roleId: string): Promise<void> {
    await ensureGuildRecord(guildId);
    run(
        `
        INSERT INTO guild_roles (guild_id, role_id)
        VALUES (:guildId, :roleId)
        ON CONFLICT (guild_id, role_id) DO NOTHING
        `,
        {
            guildId,
            roleId,
        },
    );
}

export async function removeTradeRole(guildId: string, roleId: string): Promise<void> {
    run(
        `
        DELETE FROM guild_roles WHERE guild_id = :guildId AND role_id = :roleId
        `,
        {
            guildId,
            roleId,
        },
    );
}

export async function listTradeRoles(guildId: string): Promise<string[]> {
    const rows = all<{ role_id: string }>(
        `
        SELECT role_id FROM guild_roles WHERE guild_id = :guildId ORDER BY created_at
        `,
        { guildId },
    );
    return rows.map((row) => row.role_id);
}

export async function getTradeConfig(guildId: string): Promise<{
    tradeChannelId: string | null;
    tradeChannelType: 'forum' | 'text' | null;
    adminRoleId: string | null;
}> {
    const row = get<{
        trade_channel_id: string | null;
        trade_channel_type: 'forum' | 'text' | null;
        admin_role_id: string | null;
    }>(
        `
        SELECT trade_channel_id, trade_channel_type, admin_role_id
        FROM guilds
        WHERE id = :guildId
        LIMIT 1
        `,
        { guildId },
    );

    if (!row) {
        return { tradeChannelId: null, tradeChannelType: null, adminRoleId: null };
    }

    return {
        tradeChannelId: row.trade_channel_id,
        tradeChannelType: row.trade_channel_type,
        adminRoleId: row.admin_role_id,
    };
}

export async function createTrade(params: {
    guildId: string;
    userId: string;
    title: string;
    auec: number;
    stock: number;
    imageUrl?: string | null;
    status?: TradeStatus;
}): Promise<TradeRecord> {
    const status = params.status ?? "open";
    if (!trade_status.includes(status)) {
        throw new Error(`Invalid trade status: ${status}`);
    }

    const row = get<TradeRecord>(
        `
        INSERT INTO trades (guild_id, user_id, title, auec, stock, image_url, status)
        VALUES (:guildId, :userId, :title, :auec, :stock, :imageUrl, :status)
        RETURNING *
        `,
        {
            guildId: params.guildId,
            userId: params.userId,
            title: params.title,
            auec: params.auec,
            stock: params.stock,
            imageUrl: params.imageUrl ?? null,
            status,
        },
    );

    if (!row) {
        throw new Error("Failed to create trade record");
    }
    return row;
}

export async function updateTradeAnnouncementMetadata(params: {
    tradeId: number;
    channelId?: string | null;
    messageId?: string | null;
    closeButtonId?: string | null;
    cancelButtonId?: string | null;
}): Promise<void> {
    const updates: string[] = [];
    const queryParams: QueryParams = { tradeId: params.tradeId };

    if (params.channelId !== undefined) {
        updates.push("announcement_channel_id = :channelId");
        queryParams.channelId = params.channelId ?? null;
    }

    if (params.messageId !== undefined) {
        updates.push("announcement_message_id = :messageId");
        queryParams.messageId = params.messageId ?? null;
    }

    if (params.closeButtonId !== undefined) {
        updates.push("close_button_custom_id = :closeButtonId");
        queryParams.closeButtonId = params.closeButtonId ?? null;
    }

    if (params.cancelButtonId !== undefined) {
        updates.push("cancel_button_custom_id = :cancelButtonId");
        queryParams.cancelButtonId = params.cancelButtonId ?? null;
    }

    if (updates.length === 0) {
        return;
    }

    updates.push("updated_at = datetime('now')");

    run(
        `
        UPDATE trades
        SET ${updates.join(",\n            ")}
        WHERE id = :tradeId
        `,
        queryParams,
    );
}

export async function getTradeById(tradeId: number): Promise<TradeRecord | null> {
    return get<TradeRecord>(
        `
        SELECT * FROM trades WHERE id = :tradeId LIMIT 1
        `,
        { tradeId },
    );
}

export async function listTradesByUser(params: {
    guildId: string;
    userId: string;
    status?: TradeStatus;
}): Promise<TradeRecord[]> {
    if (params.status && !trade_status.includes(params.status)) {
        throw new Error(`Invalid trade status: ${params.status}`);
    }

    if (params.status) {
        return all<TradeRecord>(
            `
            SELECT *
            FROM trades
            WHERE guild_id = :guildId AND user_id = :userId AND status = :status
            ORDER BY created_at DESC
            `,
            {
                guildId: params.guildId,
                userId: params.userId,
                status: params.status,
            },
        );
    }

    return all<TradeRecord>(
        `
        SELECT *
        FROM trades
        WHERE guild_id = :guildId AND user_id = :userId
        ORDER BY created_at DESC
        `,
        {
            guildId: params.guildId,
            userId: params.userId,
        },
    );
}

export async function getUserById(userId: string): Promise<UserRecord | null> {
    return get<UserRecord>(
        `
        SELECT * FROM users WHERE id = :userId LIMIT 1
        `,
        { userId },
    );
}

export async function updateTradeStatus(params: {
    tradeId: number;
    status: TradeStatus;
    reason?: string | null;
}): Promise<TradeRecord | null> {
    if (!trade_status.includes(params.status)) {
        throw new Error(`Invalid trade status: ${params.status}`);
    }

    return get<TradeRecord>(
        `
        UPDATE trades
        SET status = :status,
            reason = :reason,
            updated_at = datetime('now')
        WHERE id = :tradeId
        RETURNING *
        `,
        {
            tradeId: params.tradeId,
            status: params.status,
            reason: params.reason ?? null,
        },
    );
}

export async function listTrades(params: {
    guildId: string;
    status?: TradeStatus;
    page?: number;
    pageSize?: number;
}): Promise<TradeRecord[]> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.max(1, Math.min(params.pageSize ?? 10, 25));
    const offset = (page - 1) * pageSize;

    if (params.status && !trade_status.includes(params.status)) {
        throw new Error(`Invalid trade status: ${params.status}`);
    }

    console.log(params)

    if (params.status) {
        return all<TradeRecord>(
            `
            SELECT *
            FROM trades
            WHERE guild_id = :guildId AND status = :status
            ORDER BY created_at DESC
            `,
            {
                guildId: params.guildId,
                status: params.status,
                limit: pageSize,
                offset,
            },
        );
    }

    return all<TradeRecord>(
        /*sql */`
        SELECT *
        FROM trades
        WHERE guild_id = :guildId
        ORDER BY created_at DESC
        `,
        {
            guildId: params.guildId,
            limit: pageSize,
            offset,
        },
    );
}
