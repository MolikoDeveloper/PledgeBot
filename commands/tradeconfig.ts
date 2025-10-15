import {
    InteractionResponseFlags,
    InteractionResponseType,
} from "discord-interactions";

import {
    addTradeForumTag,
    addTradeRole,
    getTradeConfig,
    getTradeForumTags,
    listTradeRoles,
    removeTradeForumTag,
    removeTradeRole,
    setTradeChannel,
} from "../src/database";
import { ensureAdminAccess } from "../src/permissions";
import {
    ApplicationCommandOptionType,
    type CommandData,
    type CommandExecuteContext,
    type CommandModule,
    type CommandResponse,
    type InteractionDataOption,
    type InteractionResolvedChannel,
} from "./types";

const commandData: CommandData = {
    name: "tradeconfig",
    description: "Configure trade settings for this guild.",
    dm_permission: false,
    options: [
        {
            type: ApplicationCommandOptionType.SUB_COMMAND,
            name: "channel",
            description: "Set the primary trade channel.",
            options: [
                {
                    type: ApplicationCommandOptionType.CHANNEL,
                    name: "channel",
                    description: "Channel where trade announcements will be posted.",
                    required: true,
                },
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "type",
                    description: "Channel type",
                    required: true,
                    choices: [
                        { name: "Forum", value: "forum" },
                        { name: "Text", value: "text" },
                    ],
                },
            ],
        },
        {
            type: ApplicationCommandOptionType.SUB_COMMAND_GROUP,
            name: "roles",
            description: "Manage trade moderator roles.",
            options: [
                {
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    name: "add",
                    description: "Allow a role to moderate trades.",
                    options: [
                        {
                            type: ApplicationCommandOptionType.ROLE,
                            name: "role",
                            description: "Role to add.",
                            required: true,
                        },
                    ],
                },
                {
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    name: "remove",
                    description: "Revoke trade moderator permissions from a role.",
                    options: [
                        {
                            type: ApplicationCommandOptionType.ROLE,
                            name: "role",
                            description: "Role to remove.",
                            required: true,
                        },
                    ],
                },
                {
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    name: "list",
                    description: "Show the roles that can moderate trades.",
                },
            ],
        },
        {
            type: ApplicationCommandOptionType.SUB_COMMAND_GROUP,
            name: "forumtags",
            description: "Configure forum tags applied to trade announcements.",
            options: [
                {
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    name: "sell-add",
                    description: "Associate a forum tag with sell announcements.",
                    options: [
                        {
                            type: ApplicationCommandOptionType.STRING,
                            name: "tag_id",
                            description: "Forum tag snowflake to add.",
                            required: true,
                        },
                    ],
                },
                {
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    name: "sell-remove",
                    description: "Remove a forum tag from sell announcements.",
                    options: [
                        {
                            type: ApplicationCommandOptionType.STRING,
                            name: "tag_id",
                            description: "Forum tag snowflake to remove.",
                            required: true,
                        },
                    ],
                },
                {
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    name: "sell-list",
                    description: "List the forum tags configured for sell announcements.",
                },
                {
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    name: "buy-add",
                    description: "Associate a forum tag with buy announcements.",
                    options: [
                        {
                            type: ApplicationCommandOptionType.STRING,
                            name: "tag_id",
                            description: "Forum tag snowflake to add.",
                            required: true,
                        },
                    ],
                },
                {
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    name: "buy-remove",
                    description: "Remove a forum tag from buy announcements.",
                    options: [
                        {
                            type: ApplicationCommandOptionType.STRING,
                            name: "tag_id",
                            description: "Forum tag snowflake to remove.",
                            required: true,
                        },
                    ],
                },
                {
                    type: ApplicationCommandOptionType.SUB_COMMAND,
                    name: "buy-list",
                    description: "List the forum tags configured for buy announcements.",
                },
            ],
        },
    ],
};

type OptionLookup = Record<string, InteractionDataOption | undefined>;

type SubcommandResolution = {
    group: string | null;
    subcommand: string | null;
    options: InteractionDataOption[];
};

enum DiscordChannelType {
    GUILD_TEXT = 0,
    GUILD_FORUM = 15,
}

function buildReply(content: string): CommandResponse {
    return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
            content,
            flags: InteractionResponseFlags.EPHEMERAL,
        },
    };
}

function normalizeOptions(options: InteractionDataOption[] | undefined): OptionLookup {
    if (!options) return {};

    return options.reduce<OptionLookup>((acc, option) => {
        acc[option.name] = option;
        return acc;
    }, {});
}

function extractSubcommand(interaction: CommandExecuteContext["interaction"]): SubcommandResolution {
    const options = interaction.data.options ?? [];
    const [first] = options;

    if (!first) {
        return { group: null, subcommand: null, options: [] };
    }

    if (first.type === ApplicationCommandOptionType.SUB_COMMAND_GROUP) {
        const groupOptions = first.options ?? [];
        const [sub] = groupOptions;
        return {
            group: first.name,
            subcommand: sub?.name ?? null,
            options: sub?.options ?? [],
        };
    }

    if (first.type === ApplicationCommandOptionType.SUB_COMMAND) {
        return {
            group: null,
            subcommand: first.name,
            options: first.options ?? [],
        };
    }

    return { group: null, subcommand: null, options: [] };
}

function getStringOption(lookup: OptionLookup, name: string): string | null {
    const option = lookup[name];
    if (!option || typeof option.value !== "string") {
        return null;
    }
    return option.value;
}

async function handleChannel(params: {
    interaction: CommandExecuteContext["interaction"];
}): Promise<CommandResponse> {
    const { interaction } = params;

    if (!interaction.guild_id) {
        return buildReply("This command can only be used in a guild.");
    }

    const { options } = extractSubcommand(interaction);
    const lookup = normalizeOptions(options);

    const channelId = getStringOption(lookup, "channel");
    const channelTypeValue = getStringOption(lookup, "type") as "forum" | "text" | null;

    if (!channelId || !channelTypeValue) {
        return buildReply("Both channel and type options are required.");
    }

    const resolvedChannel: InteractionResolvedChannel | undefined =
        interaction.data.resolved?.channels?.[channelId];

    if (!resolvedChannel) {
        return buildReply("The selected channel could not be resolved.");
    }

    if (
        channelTypeValue === "text" &&
        resolvedChannel.type !== DiscordChannelType.GUILD_TEXT
    ) {
        return buildReply("Select a text channel when choosing the text option.");
    }

    if (
        channelTypeValue === "forum" &&
        resolvedChannel.type !== DiscordChannelType.GUILD_FORUM
    ) {
        return buildReply("Select a forum channel when choosing the forum option.");
    }

    await setTradeChannel({
        guildId: interaction.guild_id,
        guildName: undefined,
        channelId,
        channelType: channelTypeValue,
    });

    const channelMention = resolvedChannel.name ? `#${resolvedChannel.name}` : `<#${channelId}>`;
    return buildReply(`Trade channel set to ${channelMention} (${channelTypeValue}).`);
}

async function handleRoles(params: {
    interaction: CommandExecuteContext["interaction"];
}): Promise<CommandResponse> {
    const { interaction } = params;

    if (!interaction.guild_id) {
        return buildReply("This command can only be used in a guild.");
    }

    const resolution = extractSubcommand(interaction);
    if (resolution.group !== "roles" || !resolution.subcommand) {
        return buildReply("Unsupported subcommand.");
    }

    const lookup = normalizeOptions(resolution.options);
    const guildId = interaction.guild_id;

    switch (resolution.subcommand) {
        case "add": {
            const roleId = getStringOption(lookup, "role");
            if (!roleId) {
                return buildReply("Select a role to add.");
            }
            await addTradeRole(guildId, roleId);
            return buildReply(`Role <@&${roleId}> can now manage trades.`);
        }
        case "remove": {
            const roleId = getStringOption(lookup, "role");
            if (!roleId) {
                return buildReply("Select a role to remove.");
            }

            await removeTradeRole(guildId, roleId);
            return buildReply(`Role <@&${roleId}> can no longer manage trades.`);
        }
        case "list": {
            const roles = await listTradeRoles(guildId);
            if (roles.length === 0) {
                return buildReply("No trade moderator roles configured yet.");
            }

            const mentions = roles.map((id) => `<@&${id}>`).join("\n");
            return buildReply(`Configured trade moderator roles:\n${mentions}`);
        }
        default:
            return buildReply("Unsupported subcommand.");
    }
}

type ForumTagSubcommand = {
    type: "sell" | "buy";
    action: "add" | "remove" | "list";
};

function parseForumTagSubcommand(name: string): ForumTagSubcommand | null {
    const [type, action] = name.split("-");

    if ((type !== "sell" && type !== "buy") || !action) {
        return null;
    }

    if (action !== "add" && action !== "remove" && action !== "list") {
        return null;
    }

    return { type, action };
}

async function handleForumTags(params: {
    interaction: CommandExecuteContext["interaction"];
    resolution: SubcommandResolution;
}): Promise<CommandResponse> {
    const { interaction, resolution } = params;

    const rawGuildId = typeof interaction.guild_id === "string" ? interaction.guild_id.trim() : "";
    if (!rawGuildId) {
        return buildReply("This command can only be used in a guild.");
    }

    const guildId = rawGuildId;

    if (!resolution.subcommand) {
        return buildReply("Unsupported subcommand.");
    }

    const parsed = parseForumTagSubcommand(resolution.subcommand);
    if (!parsed) {
        return buildReply("Unsupported subcommand.");
    }

    const { type: resolvedType, action: resolvedAction } = parsed;

    const lookup = normalizeOptions(resolution.options);
    const typeLabel = resolvedType === "sell" ? "Sell" : "Buy";
    let currentConfig;
    try {
        currentConfig = await getTradeConfig(guildId);
    } catch (error) {
        console.error("Failed to load trade configuration for guild", guildId, error);
        return buildReply("Could not load the current trade configuration. Please try again later.");
    }

    if (currentConfig.tradeChannelType !== "forum" || !currentConfig.tradeChannelId) {
        return buildReply("Configure a forum trade channel before managing forum tags.");
    }

    try {
        switch (resolvedAction) {
            case "add": {
                const tagIdRaw = getStringOption(lookup, "tag_id");
                const tagId = tagIdRaw?.trim();
                if (!tagId) {
                    return buildReply(`Provide the forum tag ID to add for ${resolvedType} announcements.`);
                }

                const existingTags =
                    resolvedType === "sell"
                        ? currentConfig.sellForumTagIds
                        : currentConfig.buyForumTagIds;

                if (existingTags.includes(tagId)) {
                    return buildReply(
                        `Forum tag ${tagId} is already configured for ${typeLabel.toLowerCase()} announcements.`,
                    );
                }

                const result = await addTradeForumTag({ guildId, kind: resolvedType, tagId });
                if (!result.added) {
                    return buildReply(
                        `Forum tag ${tagId} is already configured for ${typeLabel.toLowerCase()} announcements.`,
                    );
                }

                return buildReply(`Added forum tag ${tagId} for ${typeLabel.toLowerCase()} announcements.`);
            }
            case "remove": {
                const tagIdRaw = getStringOption(lookup, "tag_id");
                const tagId = tagIdRaw?.trim();
                if (!tagId) {
                    return buildReply(`Provide the forum tag ID to remove from ${resolvedType} announcements.`);
                }

                const existingTags =
                    resolvedType === "sell"
                        ? currentConfig.sellForumTagIds
                        : currentConfig.buyForumTagIds;

                if (!existingTags.includes(tagId)) {
                    return buildReply(
                        `Forum tag ${tagId} is not configured for ${typeLabel.toLowerCase()} announcements.`,
                    );
                }

                const result = await removeTradeForumTag({ guildId, kind: resolvedType, tagId });
                if (!result.removed) {
                    return buildReply(
                        `Forum tag ${tagId} is not configured for ${typeLabel.toLowerCase()} announcements.`,
                    );
                }

                return buildReply(`Removed forum tag ${tagId} from ${typeLabel.toLowerCase()} announcements.`);
            }
            case "list": {
                const tags = await getTradeForumTags(guildId);
                const formatTagList = (tagIds: string[]): string => {
                    if (tagIds.length === 0) {
                        return "• None configured";
                    }

                    return tagIds.map((value) => `• ${value}`).join("\n");
                };

                const sellList = formatTagList(tags.sell);
                const buyList = formatTagList(tags.buy);

                const message = [
                    "Current forum tag configuration:",
                    `Sell announcements:\n${sellList}`,
                    `Buy announcements:\n${buyList}`,
                ].join("\n\n");

                return buildReply(message);
            }
            default:
                return buildReply("Unsupported subcommand.");
        }
    } catch (error) {
        console.error(
            `Failed to ${resolvedAction} forum tags for guild ${guildId} (${resolvedType})`,
            error,
        );
        return buildReply("Something went wrong while updating forum tags. Please try again later.");
    }
}

const tradeConfigCommand: CommandModule = {
    data: commandData,
    requiresAdmin: true,
    async execute({ interaction }): Promise<CommandResponse> {
        const access = await ensureAdminAccess(interaction);
        if (!access.ok) {
            return access.response;
        }

        const resolution = extractSubcommand(interaction);

        if (!resolution.subcommand) {
            return buildReply("Unsupported subcommand.");
        }

        if (resolution.group === "roles") {
            return handleRoles({ interaction });
        }

        if (resolution.group === "forumtags") {
            return handleForumTags({ interaction, resolution });
        }

        if (resolution.subcommand === "channel") {
            return handleChannel({ interaction });
        }

        return buildReply("Unsupported subcommand.");
    },
};

export default tradeConfigCommand;
