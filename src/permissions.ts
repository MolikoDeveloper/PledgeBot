import {
    InteractionResponseFlags,
    InteractionResponseType,
} from "discord-interactions";

import { getTradeConfig, listTradeRoles } from "./database";
import type {
    ChatInputCommandInteraction,
    CommandResponse,
} from "../commands/types";

const ADMINISTRATOR_BIT = 1n << 3n;

function buildReply(content: string): CommandResponse {
    return {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
            content,
            flags: InteractionResponseFlags.EPHEMERAL,
        },
    };
}

function memberHasRole(interaction: ChatInputCommandInteraction, roleId: string): boolean {
    const roles = interaction.member?.roles;
    if (!roles || roles.length === 0) {
        return false;
    }

    return roles.includes(roleId);
}

function memberHasAdministrator(interaction: ChatInputCommandInteraction): boolean {
    const permissionsRaw = interaction.member?.permissions;
    if (!permissionsRaw) {
        return false;
    }

    try {
        const permissionsValue = BigInt(permissionsRaw);
        return (permissionsValue & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT;
    } catch {
        return false;
    }
}

export async function ensureAdminAccess(
    interaction: ChatInputCommandInteraction,
    options: { allowModeratorRoles?: boolean } = {}
): Promise<{ ok: true } | { ok: false; response: CommandResponse }> {
    if (!interaction.guild_id || !interaction.member) {
        return { ok: false, response: buildReply("This command can only be used inside a guild.") };
    }

    const permissionsOk = memberHasAdministrator(interaction);

    const existingConfig = await getTradeConfig(interaction.guild_id);
    const roleOk = existingConfig.adminRoleId
        ? memberHasRole(interaction, existingConfig.adminRoleId)
        : false;

    let moderatorOk = false;
    if (!roleOk && options.allowModeratorRoles) {
        const moderatorRoles = await listTradeRoles(interaction.guild_id);
        moderatorOk = moderatorRoles.some((roleId) => memberHasRole(interaction, roleId));
    }

    if (permissionsOk || roleOk || moderatorOk) {
        return { ok: true };
    }

    return {
        ok: false,
        response: buildReply("You must have the administrator role to use this command."),
    };
}
