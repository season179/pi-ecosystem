import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** The message type Pi hands to context handlers (pi-agent-core's AgentMessage, not re-exported by name). */
export type AgentMessage = ContextEvent["messages"][number];
