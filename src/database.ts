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
    "selled",
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
    discount_percent: number | null;
    discounted_auec: number | null;
    stock: number;
    image_url: string | null;
    announcement_channel_id: string | null;
    announcement_message_id: string | null;
    done_one_button_custom_id: string | null;
    done_all_button_custom_id: string | null;
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

export type BuyOrderRecord = {
    id: number;
    guild_id: string;
    user_id: string;
    item: string;
    price: number;
    amount: number | null;
    attachment_url: string | null;
    announcement_channel_id: string | null;
    announcement_message_id: string | null;
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
            discount_percent INTEGER CHECK (discount_percent BETWEEN 0 AND 95),
            discounted_auec INTEGER,
            stock INTEGER NOT NULL DEFAULT 1,
            image_url TEXT,
            announcement_channel_id TEXT,
            announcement_message_id TEXT,
            done_one_button_custom_id TEXT,
            done_all_button_custom_id TEXT,
            cancel_button_custom_id TEXT,
            status TEXT NOT NULL CHECK (status IN ('open','matched','escrow','complete','selled','cancelled','expired')),
            reason TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS buy_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            item TEXT NOT NULL,
            price INTEGER NOT NULL,
            amount INTEGER,
            attachment_url TEXT,
            announcement_channel_id TEXT,
            announcement_message_id TEXT,
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

    let tradeColumns = db.prepare(`PRAGMA table_info(trades)`).all() as { name: string }[];
    let tradeColumnNames = new Set(tradeColumns.map((column) => column.name));

    const tradesTableDefinition = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trades'`)
        .get() as { sql: string | null } | undefined;

    const tradesTableSql = tradesTableDefinition?.sql ?? "";

    if (tradeColumnNames.size > 0 && !tradesTableSql.includes("'selled'")) {
        const selectAnnouncementChannel = tradeColumnNames.has("announcement_channel_id")
            ? "announcement_channel_id"
            : "NULL";
        const selectAnnouncementMessage = tradeColumnNames.has("announcement_message_id")
            ? "announcement_message_id"
            : "NULL";
        const selectDiscountPercent = tradeColumnNames.has("discount_percent")
            ? "discount_percent"
            : "NULL";
        const selectDiscountedAuec = tradeColumnNames.has("discounted_auec") ? "discounted_auec" : "NULL";
        const selectDoneOne = tradeColumnNames.has("done_one_button_custom_id")
            ? "done_one_button_custom_id"
            : tradeColumnNames.has("close_button_custom_id")
              ? "close_button_custom_id"
              : "NULL";
        const selectDoneAll = tradeColumnNames.has("done_all_button_custom_id")
            ? "done_all_button_custom_id"
            : "NULL";
        const selectCancel = tradeColumnNames.has("cancel_button_custom_id")
            ? "cancel_button_custom_id"
            : "NULL";
        const selectReason = tradeColumnNames.has("reason") ? "reason" : "NULL";
        const selectCreatedAt = tradeColumnNames.has("created_at")
            ? "created_at"
            : "datetime('now')";
        const selectUpdatedAt = tradeColumnNames.has("updated_at")
            ? "updated_at"
            : "datetime('now')";

        const recreateTradesTable = db.transaction(() => {
            db.run(`ALTER TABLE trades RENAME TO trades_old`);

            db.run(`
                CREATE TABLE trades (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    auec INTEGER NOT NULL,
                    discount_percent INTEGER CHECK (discount_percent BETWEEN 0 AND 95),
                    discounted_auec INTEGER,
                    stock INTEGER NOT NULL DEFAULT 1,
                    image_url TEXT,
                    announcement_channel_id TEXT,
                    announcement_message_id TEXT,
                    done_one_button_custom_id TEXT,
                    done_all_button_custom_id TEXT,
                    cancel_button_custom_id TEXT,
                    status TEXT NOT NULL CHECK (status IN ('open','matched','escrow','complete','selled','cancelled','expired')),
                    reason TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

            db.run(
                `
                INSERT INTO trades (
                    id,
                    guild_id,
                    user_id,
                    title,
                    auec,
                    ${selectDiscountPercent} AS discount_percent,
                    ${selectDiscountedAuec} AS discounted_auec,
                    stock,
                    image_url,
                    announcement_channel_id,
                    announcement_message_id,
                    done_one_button_custom_id,
                    done_all_button_custom_id,
                    cancel_button_custom_id,
                    status,
                    reason,
                    created_at,
                    updated_at
                )
                SELECT
                    id,
                    guild_id,
                    user_id,
                    title,
                    auec,
                    stock,
                    image_url,
                    ${selectAnnouncementChannel} AS announcement_channel_id,
                    ${selectAnnouncementMessage} AS announcement_message_id,
                    ${selectDoneOne} AS done_one_button_custom_id,
                    ${selectDoneAll} AS done_all_button_custom_id,
                    ${selectCancel} AS cancel_button_custom_id,
                    status,
                    ${selectReason} AS reason,
                    ${selectCreatedAt} AS created_at,
                    ${selectUpdatedAt} AS updated_at
                FROM trades_old
                `,
            );

            db.run(`DROP TABLE trades_old`);
        });

        recreateTradesTable();

        tradeColumns = db.prepare(`PRAGMA table_info(trades)`).all() as { name: string }[];
        tradeColumnNames = new Set(tradeColumns.map((column) => column.name));
    }

    if (!tradeColumnNames.has("announcement_channel_id")) {
        db.run(`ALTER TABLE trades ADD COLUMN announcement_channel_id TEXT`);
    }

    if (!tradeColumnNames.has("announcement_message_id")) {
        db.run(`ALTER TABLE trades ADD COLUMN announcement_message_id TEXT`);
    }

    if (!tradeColumnNames.has("done_one_button_custom_id")) {
        if (tradeColumnNames.has("close_button_custom_id")) {
            db.run(`ALTER TABLE trades RENAME COLUMN close_button_custom_id TO done_one_button_custom_id`);
        } else {
            db.run(`ALTER TABLE trades ADD COLUMN done_one_button_custom_id TEXT`);
        }
    }

    if (!tradeColumnNames.has("done_all_button_custom_id")) {
        db.run(`ALTER TABLE trades ADD COLUMN done_all_button_custom_id TEXT`);
    }

    if (!tradeColumnNames.has("cancel_button_custom_id")) {
        db.run(`ALTER TABLE trades ADD COLUMN cancel_button_custom_id TEXT`);
    }

    if (!tradeColumnNames.has("discount_percent")) {
        db.run(`ALTER TABLE trades ADD COLUMN discount_percent INTEGER CHECK (discount_percent BETWEEN 0 AND 95)`);
    }

    if (!tradeColumnNames.has("discounted_auec")) {
        db.run(`ALTER TABLE trades ADD COLUMN discounted_auec INTEGER`);
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

export async function createBuyOrder(params: {
    guildId: string;
    userId: string;
    item: string;
    price: number;
    amount?: number | null;
    attachmentUrl?: string | null;
}): Promise<BuyOrderRecord> {
    if (!Number.isInteger(params.price) || params.price <= 0) {
        throw new Error("Price must be a positive integer value");
    }

    let amount: number | null = null;
    if (params.amount !== undefined && params.amount !== null) {
        if (!Number.isInteger(params.amount) || params.amount <= 0) {
            throw new Error("Amount must be a positive integer value when provided");
        }
        amount = params.amount;
    }

    const row = get<BuyOrderRecord>(
        `
        INSERT INTO buy_orders (guild_id, user_id, item, price, amount, attachment_url)
        VALUES (:guildId, :userId, :item, :price, :amount, :attachmentUrl)
        RETURNING *
        `,
        {
            guildId: params.guildId,
            userId: params.userId,
            item: params.item,
            price: params.price,
            amount,
            attachmentUrl: params.attachmentUrl ?? null,
        },
    );

    if (!row) {
        throw new Error("Failed to create buy order record");
    }

    return row;
}

export async function updateTradeAnnouncementMetadata(params: {
    tradeId: number;
    channelId?: string | null;
    messageId?: string | null;
    doneOneButtonId?: string | null;
    doneAllButtonId?: string | null;
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

    if (params.doneOneButtonId !== undefined) {
        updates.push("done_one_button_custom_id = :doneOneButtonId");
        queryParams.doneOneButtonId = params.doneOneButtonId ?? null;
    }

    if (params.doneAllButtonId !== undefined) {
        updates.push("done_all_button_custom_id = :doneAllButtonId");
        queryParams.doneAllButtonId = params.doneAllButtonId ?? null;
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

export async function updateBuyOrderAnnouncementMetadata(params: {
    orderId: number;
    channelId?: string | null;
    messageId?: string | null;
}): Promise<void> {
    const updates: string[] = [];
    const queryParams: QueryParams = { orderId: params.orderId };

    if (params.channelId !== undefined) {
        updates.push("announcement_channel_id = :channelId");
        queryParams.channelId = params.channelId ?? null;
    }

    if (params.messageId !== undefined) {
        updates.push("announcement_message_id = :messageId");
        queryParams.messageId = params.messageId ?? null;
    }

    if (updates.length === 0) {
        return;
    }

    updates.push("updated_at = datetime('now')");

    run(
        `
        UPDATE buy_orders
        SET ${updates.join(",\n            ")}
        WHERE id = :orderId
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

export async function reduceTradeStock(params: {
    tradeId: number;
    amount: number;
}): Promise<TradeRecord | null> {
    if (!Number.isInteger(params.amount) || params.amount <= 0) {
        throw new Error("Amount must be a positive integer");
    }

    return get<TradeRecord>(
        `
        UPDATE trades
        SET stock = stock - :amount,
            status = CASE WHEN stock - :amount <= 0 THEN 'selled' ELSE status END,
            updated_at = datetime('now')
        WHERE id = :tradeId
            AND stock >= :amount
            AND status = 'open'
        RETURNING *
        `,
        {
            tradeId: params.tradeId,
            amount: params.amount,
        },
    );
}

export async function updateTradeDiscount(params: {
    tradeId: number;
    percent: number | null;
}): Promise<TradeRecord | null> {
    const { tradeId } = params;
    const percent = params.percent;

    if (percent !== null) {
        if (!Number.isInteger(percent)) {
            throw new Error("Discount percent must be an integer value");
        }

        if (percent < 0 || percent > 95) {
            throw new Error("Discount percent must be between 0 and 95");
        }
    }

    return get<TradeRecord>(
        `
        UPDATE trades
        SET discount_percent = :percent,
            discounted_auec = CASE
                WHEN :percent IS NULL THEN NULL
                ELSE CAST(ROUND(auec * (100 - :percent) / 100.0) AS INTEGER)
            END,
            updated_at = datetime('now')
        WHERE id = :tradeId
        RETURNING *
        `,
        {
            tradeId,
            percent: percent ?? null,
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
        LIMIT :limit OFFSET :offset
        `,
        {
            guildId: params.guildId,
            limit: pageSize,
            offset,
        },
    );
}

export async function listBuyOrders(params: {
    guildId: string;
    page?: number;
    pageSize?: number;
}): Promise<BuyOrderRecord[]> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.max(1, Math.min(params.pageSize ?? 10, 25));
    const offset = (page - 1) * pageSize;

    return all<BuyOrderRecord>(
        `
        SELECT *
        FROM buy_orders
        WHERE guild_id = :guildId
        ORDER BY created_at DESC
        LIMIT :limit OFFSET :offset
        `,
        {
            guildId: params.guildId,
            limit: pageSize,
            offset,
        },
    );
}
