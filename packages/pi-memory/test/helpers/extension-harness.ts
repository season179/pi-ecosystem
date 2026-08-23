import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AnyHandler = (...args: any[]) => any;

export interface CapturedTool {
	name: string;
	parameters: Record<string, unknown>;
	prepareArguments?: (arguments_: unknown) => unknown;
	execute: AnyHandler;
	[key: string]: unknown;
}

export interface CapturedCommand {
	description?: string;
	handler: AnyHandler;
	getArgumentCompletions?: AnyHandler;
	[key: string]: unknown;
}

export interface HarnessContext {
	context: Record<string, any>;
	notifications: Array<{ message: string; level: string | undefined }>;
	statuses: Array<{ key: string; value: string | undefined }>;
}

/** Minimal public ExtensionAPI registration harness; no Pi runner internals. */
export class ExtensionRegistrationHarness {
	readonly tools = new Map<string, CapturedTool>();
	readonly commands = new Map<string, CapturedCommand>();
	readonly hooks = new Map<string, AnyHandler[]>();
	readonly sentMessages: unknown[] = [];

	readonly api = {
		registerTool: (tool: CapturedTool) => {
			this.tools.set(tool.name, tool);
		},
		registerCommand: (name: string, command: CapturedCommand) => {
			this.commands.set(name, command);
		},
		on: (event: string, handler: AnyHandler) => {
			const handlers = this.hooks.get(event) ?? [];
			handlers.push(handler);
			this.hooks.set(event, handlers);
		},
		sendMessage: (message: unknown) => {
			this.sentMessages.push(message);
		},
	} as unknown as ExtensionAPI;

	tool(name: string): CapturedTool {
		const tool = this.tools.get(name);
		if (tool === undefined) throw new Error(`Tool was not registered: ${name}`);
		return tool;
	}

	command(name: string): CapturedCommand {
		const command = this.commands.get(name);
		if (command === undefined) throw new Error(`Command was not registered: ${name}`);
		return command;
	}

	async emit(event: string, payload: unknown, context: unknown): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.hooks.get(event) ?? []) results.push(await handler(payload, context));
		return results;
	}
}

export function makeExtensionContext(
	cwd: string,
	overrides: Record<string, unknown> = {},
): HarnessContext {
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const context: Record<string, any> = {
		cwd,
		mode: "rpc",
		hasUI: true,
		isProjectTrusted: () => true,
		isIdle: () => true,
		waitForIdle: async () => undefined,
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionFile: () => undefined,
		},
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
			confirm: async () => true,
		},
		...overrides,
	};
	return { context, notifications, statuses };
}
