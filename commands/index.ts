import buyCommand from "./buy";
import helpCommand from "./help";
import sellCommand from "./sell";
import tradeCommand from "./trade";
import tradeConfigCommand from "./tradeconfig";
import type { CommandModule } from "./types";

export const commands: CommandModule[] = [
    sellCommand,
    buyCommand,
    tradeCommand,
    tradeConfigCommand,
    helpCommand,
];

export const commandMap = new Map(commands.map((command) => [command.data.name, command]));

export default commands;
