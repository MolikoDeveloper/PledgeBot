import sellCommand from "./sell";
import tradeCommand from "./trade";
import tradeConfigCommand from "./tradeconfig";
import type { CommandModule } from "./types";

export const commands: CommandModule[] = [sellCommand, tradeCommand, tradeConfigCommand];

export const commandMap = new Map(commands.map((command) => [command.data.name, command]));

export default commands;
