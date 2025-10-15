import {
    InteractionResponseFlags,
    InteractionResponseType,
    InteractionType,
    verifyKey,
} from "discord-interactions";

import commands, { commandMap } from "./commands";
import { handleTradeComponent } from "./commands/trade-component";
import {
    ApplicationCommandType,
    type ChatInputCommandInteraction,
    type CommandResponse,
    type MessageComponentInteraction,
} from "./commands/types";
import { config } from "./src/config";
import { initializeDatabase } from "./src/database";

const port = Number(process.env.PORT ?? 4567);
const decoder = new TextDecoder();

async function syncCommands(): Promise<void> {
    if (config.allowOffline) {
        console.info("Skipping command sync because offline mode is enabled.");
        return;
    }

    const payload = commands.map((command) => ({
        ...command.data,
        type: command.data.type ?? ApplicationCommandType.CHAT_INPUT,
    }));

    const baseUrl = `https://discord.com/api/v10/applications/${config.clientId}`;
    const routes = config.guildIds.length > 0
        ? config.guildIds.map((guildId) => ({
              label: `guild ${guildId}`,
              url: `${baseUrl}/guilds/${guildId}/commands`,
          }))
        : [{ label: "global", url: `${baseUrl}/commands` }];

    const headers = {
        Authorization: `Bot ${config.botToken}`,
        "Content-Type": "application/json",
    };

    for (const route of routes) {
        try {
            const response = await fetch(route.url, {
                method: "PUT",
                headers,
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                let message: string;
                try {
                    message = JSON.stringify(await response.json());
                } catch {
                    message = await response.text();
                }
                console.error(`Failed to sync commands to ${route.label}: ${response.status} ${response.statusText} - ${message}`);
                continue;
            }

            console.log(`Synced ${payload.length} commands to ${route.label}.`);
        } catch (error) {
            console.error(`Failed to sync commands to ${route.label}`, error);
        }
    }
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
    const headers = new Headers();

    const existing = init?.headers;
    if (existing) {
        if (Array.isArray(existing)) {
            existing.forEach(([key, value]) => {
                headers.append(key, value);
            });
        } else if (existing instanceof Headers) {
            existing.forEach((value, key) => {
                headers.append(key, value);
            });
        } else {
            const record = existing as Record<string, string | readonly string[] | undefined>;
            for (const [key, value] of Object.entries(record)) {
                if (Array.isArray(value)) {
                    value.forEach((item) => headers.append(key, item));
                } else if (typeof value === "string") {
                    headers.append(key, value);
                }
            }
        }
    }

    headers.set("Content-Type", "application/json");

    const responseInit: ResponseInit = {
        ...init,
        headers,
    };

    return new Response(JSON.stringify(payload), responseInit);
}

async function handleInteraction(request: Request): Promise<Response> {
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");

    if (!signature || !timestamp) {
        return new Response("Missing signature headers", { status: 401 });
    }

    const rawBody = new Uint8Array(await request.arrayBuffer());

    const isValid = await verifyKey(rawBody, signature, timestamp, config.publicKey);

    if (!isValid) {
        return new Response("Bad request signature", { status: 401 });
    }

    let payload: unknown;
    try {
        payload = JSON.parse(decoder.decode(rawBody));
    } catch (error) {
        console.error("Failed to parse interaction payload", error);
        return new Response("Invalid JSON", { status: 400 });
    }

    const base = payload as { type?: number } | undefined;

    if (base?.type === InteractionType.PING) {
        return jsonResponse({ type: InteractionResponseType.PONG });
    }

    if (base?.type === InteractionType.MESSAGE_COMPONENT) {
        const interaction = payload as MessageComponentInteraction;

        try {
            const response = await handleTradeComponent({ interaction, config });
            return jsonResponse(response);
        } catch (error) {
            console.error("Component interaction handler failed", error);
            return jsonResponse({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                    content: "An unexpected error occurred while processing the component interaction.",
                    flags: InteractionResponseFlags.EPHEMERAL,
                },
            });
        }
    }

    if (base?.type !== InteractionType.APPLICATION_COMMAND) {
        return jsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
                content: "Unsupported interaction type.",
                flags: InteractionResponseFlags.EPHEMERAL,
            },
        });
    }

    const interaction = payload as ChatInputCommandInteraction;

    const commandName = interaction.data?.name;
    if (!commandName) {
        return jsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
                content: "Interaction is missing a command name.",
                flags: InteractionResponseFlags.EPHEMERAL,
            },
        });
    }

    const command = commandName ? commandMap.get(commandName) : undefined;
    if (!command) {
        return jsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
                content: `Unknown command: ${commandName}.`,
                flags: InteractionResponseFlags.EPHEMERAL,
            },
        });
    }

    let response: CommandResponse;
    try {
        response = await command.execute({ interaction, config });
    } catch (error) {
        console.error(`Command ${commandName} failed`, error);
        return jsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
                content: "An unexpected error occurred while processing the command.",
                flags: InteractionResponseFlags.EPHEMERAL,
            },
        });
    }

    return jsonResponse(response);
}

async function initWsClient() {
    const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    let hb: any, seq: number | null = null;

    ws.onmessage = (ev) => {
        const p = JSON.parse(ev.data);
        if ("s" in p && p.s != null) seq = p.s;

        switch (p.op) {
            case 10: { // HELLO
                const interval = p.d.heartbeat_interval;
                hb = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), interval);
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: process.env.D_bot_token,
                        properties: { os: "linux", browser: "bun", device: "bun" },
                        intents: 0,
                        presence: {
                            status: "online",
                            afk: false,
                            activities: [{ name: "wanna trade?", type: 3 }],
                            since: null,
                        },
                    },
                }));
                break;
            }
            case 11: /* HEARTBEAT_ACK */ break;
            case 7:  /* RECONNECT      */ ws.close(); break;
            case 9:  /* INVALID_SESSION */ setTimeout(() => ws.close(), 1000); break;
        }
    };
    ws.onclose = () => { if (hb) clearInterval(hb); };
}

await initializeDatabase();
await syncCommands();
initWsClient();

const server = Bun.serve({
    port,
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/interactions") {
            return handleInteraction(request);
        }

        return new Response("Not Found", { status: 404 });
    },
});

console.log(`PledgeBot listening on http://localhost:${server.port}`);
