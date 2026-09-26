import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { AgentHub, MAX_SLOTS } from "../agent-hub.js";
import { renderKey } from "../render.js";

/** Spinner/elapsed refresh rate; only running slots are redrawn this often. */
const TICK_MS = 250;

function toSlot(value: unknown): number | undefined {
	const slot = Number(value);
	return Number.isInteger(slot) && slot >= 1 && slot <= MAX_SLOTS ? slot : undefined;
}

export type SlotSettings = {
	/** 1-based slot number. Auto-assigned on first appearance. */
	slot?: number;
	/** Absolute workspace path to lock this key to; empty means auto. */
	pinnedPath?: string;
} & JsonObject;

@action({ UUID: "com.marcoweber.copilot-agents.slot" })
export class AgentSlotAction extends SingletonAction<SlotSettings> {
	readonly #hub: AgentHub;
	readonly #visible = new Map<string, { action: KeyAction<SlotSettings>; slot: number }>();
	#tick = 0;
	#timer: NodeJS.Timeout | undefined;

	public constructor(hub: AgentHub) {
		super();
		this.#hub = hub;
		this.#hub.on("changed", () => void this.#renderAll());
	}

	public override async onWillAppear(ev: WillAppearEvent<SlotSettings>): Promise<void> {
		if (!ev.action.isKey()) return;

		const settings = await ev.action.getSettings();
		const slot = toSlot(settings.slot) ?? this.#positionalSlot(ev.action);

		this.#bind(ev.action, slot);
		this.#hub.pin(slot, settings.pinnedPath || undefined);
		this.#ensureTimer();

		if (settings.slot !== slot) await ev.action.setSettings({ ...settings, slot });
		await this.#render(ev.action, slot);
	}

	public override onWillDisappear(ev: WillDisappearEvent<SlotSettings>): void {
		this.#visible.delete(ev.action.id);
		this.#syncActiveSlots();
		if (this.#visible.size === 0 && this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	public override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SlotSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const slot = toSlot(ev.payload.settings.slot) ?? this.#visible.get(ev.action.id)?.slot ?? this.#positionalSlot(ev.action);
		this.#bind(ev.action, slot);
		this.#hub.pin(slot, ev.payload.settings.pinnedPath || undefined);
		await this.#render(ev.action, slot);
	}

	public override async onKeyDown(ev: KeyDownEvent<SlotSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const slot = toSlot(ev.payload.settings.slot) ?? this.#visible.get(ev.action.id)?.slot ?? 1;
		const { session } = this.#hub.slot(slot);

		if (!session) {
			await ev.action.showAlert();
			return;
		}

		this.#hub.acknowledge(slot);
		const focused = await this.#hub.focus(slot);
		if (!focused) await ev.action.showAlert();
		await this.#render(ev.action, slot);
	}

	/** Serves the workspace picker in the property inspector. */
	public override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SlotSettings>): Promise<void> {
		if ((ev.payload as { event?: string })?.event !== "getWorkspaces") return;
		await streamDeck.ui.sendToPropertyInspector({
			event: "getWorkspaces",
			items: [
				{ label: "Auto (next active agent)", value: "" },
				...this.#hub.workspaces().map((w) => ({ label: w.name, value: w.path }))
			]
		});
	}

	#bind(keyAction: KeyAction<SlotSettings>, slot: number): void {
		this.#visible.set(keyAction.id, { action: keyAction, slot });
		this.#syncActiveSlots();
	}

	#syncActiveSlots(): void {
		this.#hub.setActiveSlots(new Set([...this.#visible.values()].map((v) => v.slot)));
	}

	/** Numbers keys in reading order across the deck, so the top-left key is slot 1. */
	#positionalSlot(keyAction: KeyAction<SlotSettings>): number {
		const coordinates = keyAction.coordinates;
		const columns = keyAction.device.size?.columns ?? 5;
		if (coordinates) {
			const slot = toSlot(coordinates.row * columns + coordinates.column + 1);
			if (slot) return slot;
		}
		const used = new Set([...this.#visible.values()].map((v) => v.slot));
		for (let index = 1; index <= MAX_SLOTS; index++) {
			if (!used.has(index)) return index;
		}
		return 1;
	}

	#ensureTimer(): void {
		this.#timer ??= setInterval(() => {
			this.#tick++;
			void this.#renderAll(true);
		}, TICK_MS);
	}

	async #renderAll(animatingOnly = false): Promise<void> {
		const now = Date.now();
		await Promise.all(
			[...this.#visible.values()].map(({ action: keyAction, slot }) => {
				if (animatingOnly) {
					const { session } = this.#hub.slot(slot);
					if (session?.status !== "running" || session.stale) return undefined;
				}
				return this.#render(keyAction, slot, now);
			})
		);
	}

	async #render(keyAction: KeyAction<SlotSettings>, slot: number, now = Date.now()): Promise<void> {
		const { session, acknowledged } = this.#hub.slot(slot);
		try {
			await keyAction.setImage(renderKey({ slotIndex: slot, session, acknowledged, tick: this.#tick, now }));
		} catch (error) {
			streamDeck.logger.warn(`failed to render slot ${slot}`, error);
		}
	}
}
