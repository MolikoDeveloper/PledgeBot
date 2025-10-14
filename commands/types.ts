import type { InteractionResponseType, InteractionType } from "discord-interactions";
import type { AppConfig } from "../src/config";

export enum ApplicationCommandType {
    CHAT_INPUT = 1,
}

export enum ApplicationCommandOptionType {
    SUB_COMMAND = 1,
    SUB_COMMAND_GROUP = 2,
    STRING = 3,
    INTEGER = 4,
    BOOLEAN = 5,
    USER = 6,
    CHANNEL = 7,
    ROLE = 8,
    MENTIONABLE = 9,
    NUMBER = 10,
    ATTACHMENT = 11,
}

export interface CommandChoice {
    name: string;
    value: string | number;
}

export enum ComponentType {
    ACTION_ROW = 1,
    BUTTON = 2,
}

export enum ButtonStyle {
    PRIMARY = 1,
    SECONDARY = 2,
    SUCCESS = 3,
    DANGER = 4,
    LINK = 5,
}

export interface ButtonComponent {
    type: ComponentType.BUTTON;
    style: ButtonStyle;
    label: string;
    custom_id: string;
    disabled?: boolean;
    emoji?: {
        id?: string;
        name?: string;
        animated?: boolean;
    };
}

export interface ActionRowComponent {
    type: ComponentType.ACTION_ROW;
    components: ButtonComponent[];
}

export type MessageComponent = ActionRowComponent;

interface BaseCommandOption {
    type: ApplicationCommandOptionType;
    name: string;
    description: string;
    required?: boolean;
}

export type CommandOption =
    | (BaseCommandOption & {
          type: ApplicationCommandOptionType.SUB_COMMAND;
          options?: CommandOption[];
      })
    | (BaseCommandOption & {
          type: ApplicationCommandOptionType.SUB_COMMAND_GROUP;
          options: CommandOption[];
      })
    | (BaseCommandOption & {
          type: ApplicationCommandOptionType.STRING;
          choices?: CommandChoice[];
          min_length?: number;
          max_length?: number;
      })
    | (BaseCommandOption & {
          type: ApplicationCommandOptionType.INTEGER | ApplicationCommandOptionType.NUMBER;
          choices?: CommandChoice[];
          min_value?: number;
          max_value?: number;
      })
    | (BaseCommandOption & {
          type: ApplicationCommandOptionType.ATTACHMENT;
      })
    | (BaseCommandOption & {
          type:
              | ApplicationCommandOptionType.BOOLEAN
              | ApplicationCommandOptionType.USER
              | ApplicationCommandOptionType.ROLE
              | ApplicationCommandOptionType.MENTIONABLE;
      })
    | (BaseCommandOption & {
          type: ApplicationCommandOptionType.CHANNEL;
          channel_types?: number[];
      });

export interface CommandData {
    name: string;
    description: string;
    type?: ApplicationCommandType;
    dm_permission?: boolean;
    default_member_permissions?: string | null;
    options?: CommandOption[];
}

export interface InteractionUser {
    id: string;
    username: string;
    global_name?: string | null;
    discriminator?: string;
}

export interface InteractionMember {
    user?: InteractionUser;
    roles?: string[];
    permissions?: string;
    nick?: string | null;
}

export interface InteractionDataOption {
    name: string;
    type: ApplicationCommandOptionType;
    value?: string | number | boolean;
    options?: InteractionDataOption[];
}

export interface InteractionAttachment {
    id: string;
    filename: string;
    size: number;
    url: string;
    proxy_url?: string;
    content_type?: string;
}

export interface InteractionResolvedChannel {
    id: string;
    name?: string;
    type: number;
    parent_id?: string;
}

export interface InteractionResolvedRole {
    id: string;
    name: string;
    permissions: string;
}

export interface InteractionResolvedData {
    users?: Record<string, InteractionUser>;
    members?: Record<string, InteractionMember>;
    channels?: Record<string, InteractionResolvedChannel>;
    roles?: Record<string, InteractionResolvedRole>;
    attachments?: Record<string, InteractionAttachment>;
}

export interface ChatInputCommandData {
    id: string;
    name: string;
    type: ApplicationCommandType;
    options?: InteractionDataOption[];
    resolved?: InteractionResolvedData;
}

export interface ChatInputCommandInteraction {
    id: string;
    application_id: string;
    type: InteractionType;
    data: ChatInputCommandData;
    guild_id?: string;
    channel_id?: string;
    member?: InteractionMember;
    user?: InteractionUser;
    token: string;
}

export interface InteractionMessageResponseData {
    content?: string;
    flags?: number;
    components?: MessageComponent[];
}

export type CommandResponse = {
    type: InteractionResponseType;
    data?: InteractionMessageResponseData;
};

export interface CommandExecuteContext {
    interaction: ChatInputCommandInteraction;
    config: AppConfig;
}

export interface CommandModule {
    data: CommandData;
    requiresAdmin?: boolean;
    execute: (context: CommandExecuteContext) => Promise<CommandResponse>;
}
