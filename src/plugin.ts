import streamDeck from "@elgato/streamdeck";
import { AgentSlotAction } from "./actions/agent-slot.js";
import { AgentHub } from "./agent-hub.js";

const hub = new AgentHub();
hub.on("warning", (message: string) => streamDeck.logger.warn(message));

streamDeck.actions.registerAction(new AgentSlotAction(hub));

await streamDeck.connect();
await hub.start();

streamDeck.logger.info("Copilot Agents plugin connected");
