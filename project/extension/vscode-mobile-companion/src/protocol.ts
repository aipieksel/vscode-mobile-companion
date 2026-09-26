/**
 * VS Code Mobile Companion - Relay Protocol v1
 *
 * Shared type definitions for WebSocket messages between the extension,
 * relay backend, and mobile clients.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Workspace & Device
// ---------------------------------------------------------------------------

export interface WorkspaceDescriptor {
  id: string;
  name: string;
  path: string;
}

export interface Capabilities {
  paired: boolean;
  connected: boolean;
  workspaceCount: number;
  providersAvailable: string[];
  sessionSyncHealthy: boolean;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatEntry {
  id: string;
  deviceId: string;
  workspaceId: string;
  provider: string;
  role: "user" | "assistant";
  content: string;
  promptId?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// WebSocket Messages (desktop <-> relay <-> mobile)
// ---------------------------------------------------------------------------

/** Sent by desktop immediately after WS connection. */
export interface DesktopHelloMessage {
  type: "desktop_hello";
  protocol: typeof PROTOCOL_VERSION;
  deviceId: string;
  workspaceId: string;
  workspaces: WorkspaceDescriptor[];
  capabilities: Capabilities;
}

/** Periodic status update from desktop to relay. */
export interface DesktopStatusMessage {
  type: "desktop_status";
  protocol: typeof PROTOCOL_VERSION;
  deviceId: string;
  workspaceId: string;
  workspaces: WorkspaceDescriptor[];
  capabilities: Capabilities;
}

/** Relay -> desktop: send a prompt to VS Code chat. */
export interface SendPromptMessage {
  type: "send_prompt";
  protocol: typeof PROTOCOL_VERSION;
  workspaceId: string;
  provider: string;
  content: string;
  promptId: string;
}

/** Desktop -> relay: assistant reply for a companion-originated prompt. */
export interface ChatReplyMessage {
  type: "chat_reply";
  protocol: typeof PROTOCOL_VERSION;
  workspaceId: string;
  provider: string;
  content: string;
  promptId: string;
  isComplete: boolean;
}

/** Relay -> mobile/desktop: pairing approved notification. */
export interface PairApprovedMessage {
  type: "pair_approved";
  protocol: typeof PROTOCOL_VERSION;
  deviceId: string;
}

/** Union of all relay message types. */
export type RelayMessage =
  | DesktopHelloMessage
  | DesktopStatusMessage
  | SendPromptMessage
  | ChatReplyMessage
  | PairApprovedMessage;
