import * as http from "http";
import { randomUUID } from "crypto";
import WebSocket, { WebSocketServer } from "ws";
import { PROTOCOL_VERSION, type ChatEntry, type ChatReplyMessage, type DesktopHelloMessage, type DesktopStatusMessage, type RelayMessage, type WorkspaceDescriptor, type Capabilities } from "./protocol";

type ClientKind = "desktop" | "mobile";

interface PairingRecord {
  code: string;
  deviceId: string;
  userToken: string;
  approved: boolean;
  pairUrl: string;
  expiresAt: string;
}

interface DeviceContext {
  deviceId: string;
  userToken: string;
  workspaces: WorkspaceDescriptor[];
  capabilities?: Capabilities;
  /** Map of workspaceId -> desktop WebSocket (one per VS Code window) */
  desktopSockets: Map<string, WebSocket>;
  mobileSockets: Set<WebSocket>;
}

const port = Number(process.env.PORT || "8787");
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;

const pairings = new Map<string, PairingRecord>();
const devices = new Map<string, DeviceContext>();
const history = new Map<string, ChatEntry[]>();

function keyFor(deviceId: string, workspaceId: string, provider: string) {
  return `${deviceId}:${workspaceId}:${provider}`;
}

function authToken(req: http.IncomingMessage) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "local-dev-user";
}

function readBody(req: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function contextFor(deviceId: string, userToken: string) {
  const existing = devices.get(deviceId);
  if (existing) {
    return existing;
  }
  const created: DeviceContext = {
    deviceId,
    userToken,
    workspaces: [],
    desktopSockets: new Map(),
    mobileSockets: new Set()
  };
  devices.set(deviceId, created);
  return created;
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    json(res, 400, { error: "Missing URL" });
    return;
  }

  const url = new URL(req.url, publicBaseUrl);
  const userToken = authToken(req);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      pairings: pairings.size,
      devices: devices.size
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/pair/start") {
    const payload = JSON.parse((await readBody(req)) || "{}") as {
      deviceName?: string;
      platform?: string;
      workspaces?: WorkspaceDescriptor[];
    };
    const deviceId = randomUUID();
    const pairCode = Math.random().toString().slice(2, 8);
    const record: PairingRecord = {
      code: pairCode,
      deviceId,
      userToken,
      approved: false,
      pairUrl: `${publicBaseUrl}/pair/${pairCode}`,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    };
    pairings.set(pairCode, record);

    const context = contextFor(deviceId, userToken);
    context.workspaces = payload.workspaces || [];

    json(res, 200, record);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/pair/approve") {
    const payload = JSON.parse((await readBody(req)) || "{}") as { code?: string };
    const record = payload.code ? pairings.get(payload.code) : undefined;
    if (!record) {
      json(res, 404, { error: "Unknown pairing code" });
      return;
    }
    record.approved = true;
    const context = contextFor(record.deviceId, record.userToken);
    for (const socket of context.mobileSockets) {
      socket.send(JSON.stringify({ type: "pair_approved", protocol: PROTOCOL_VERSION, deviceId: record.deviceId }));
    }
    for (const socket of context.desktopSockets.values()) {
      socket.send(JSON.stringify({ type: "pair_approved", protocol: PROTOCOL_VERSION, deviceId: record.deviceId }));
    }
    json(res, 200, {
      ok: true,
      deviceId: record.deviceId,
      pairUrl: record.pairUrl
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/workspaces") {
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId || !devices.has(deviceId)) {
      json(res, 404, { error: "Unknown device" });
      return;
    }
    json(res, 200, {
      deviceId,
      workspaces: devices.get(deviceId)?.workspaces || [],
      capabilities: devices.get(deviceId)?.capabilities || null
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chats/send") {
    const payload = JSON.parse((await readBody(req)) || "{}") as {
      deviceId?: string;
      workspaceId?: string;
      provider?: string;
      content?: string;
    };
    if (!payload.deviceId || !payload.workspaceId || !payload.provider || !payload.content) {
      json(res, 400, { error: "deviceId, workspaceId, provider, and content are required" });
      return;
    }
    const context = devices.get(payload.deviceId);
    const desktopSocket = context?.desktopSockets.get(payload.workspaceId);
    if (!desktopSocket || desktopSocket.readyState !== WebSocket.OPEN) {
      json(res, 409, { error: "Desktop is not connected for this workspace" });
      return;
    }

    const promptId = randomUUID();
    const entry: ChatEntry = {
      id: promptId,
      deviceId: payload.deviceId,
      workspaceId: payload.workspaceId,
      provider: payload.provider,
      role: "user",
      content: payload.content,
      createdAt: new Date().toISOString()
    };
    const chatKey = keyFor(payload.deviceId, payload.workspaceId, payload.provider);
    history.set(chatKey, [...(history.get(chatKey) || []), entry]);

    desktopSocket.send(JSON.stringify({
      type: "send_prompt",
      protocol: PROTOCOL_VERSION,
      workspaceId: payload.workspaceId,
      provider: payload.provider,
      content: payload.content,
      promptId
    }));

    json(res, 202, { ok: true, queued: true, id: promptId });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/chats/history") {
    const deviceId = url.searchParams.get("deviceId");
    const workspaceId = url.searchParams.get("workspaceId");
    const provider = url.searchParams.get("provider");
    if (!deviceId || !workspaceId || !provider) {
      json(res, 400, { error: "deviceId, workspaceId, and provider are required" });
      return;
    }
    json(res, 200, {
      entries: history.get(keyFor(deviceId, workspaceId, provider)) || []
    });
    return;
  }

  json(res, 404, { error: "Not found" });
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (socket: WebSocket, req: http.IncomingMessage, clientKind: ClientKind) => {
  const url = new URL(req.url || "/", publicBaseUrl);
  const userToken = authToken(req);
  const deviceId = url.searchParams.get("deviceId");
  const workspaceId = url.searchParams.get("workspaceId") || "_default";

  if (!deviceId) {
    socket.close();
    return;
  }

  const context = contextFor(deviceId, userToken);
  if (clientKind === "desktop") {
    context.desktopSockets.set(workspaceId, socket);
  } else {
    context.mobileSockets.add(socket);
  }

  socket.on("message", (raw: WebSocket.RawData) => {
    const message = JSON.parse(String(raw)) as RelayMessage;

    if (message.type === "desktop_hello") {
      const hello = message as DesktopHelloMessage;
      // Re-register with the actual workspaceId from the hello message
      if (hello.workspaceId && hello.workspaceId !== workspaceId) {
        context.desktopSockets.delete(workspaceId);
        context.desktopSockets.set(hello.workspaceId, socket);
      }
      // Merge workspace list from this window
      const existingIds = new Set(context.workspaces.map((w) => w.id));
      for (const ws of hello.workspaces || []) {
        if (!existingIds.has(ws.id)) {
          context.workspaces.push(ws);
        }
      }
      context.capabilities = hello.capabilities;
      const payload = JSON.stringify({
        type: "desktop_status",
        protocol: PROTOCOL_VERSION,
        deviceId,
        workspaces: context.workspaces,
        capabilities: context.capabilities
      });
      for (const mobile of context.mobileSockets) {
        mobile.send(payload);
      }
      return;
    }

    if (message.type === "desktop_status") {
      const status = message as DesktopStatusMessage;
      // Update workspaces for this specific window's workspace
      context.workspaces = context.workspaces.filter((w) => w.id !== status.workspaceId);
      for (const ws of status.workspaces || []) {
        context.workspaces.push(ws);
      }
      context.capabilities = status.capabilities;
      const payload = JSON.stringify({
        type: "desktop_status",
        protocol: PROTOCOL_VERSION,
        deviceId,
        workspaces: context.workspaces,
        capabilities: context.capabilities
      });
      for (const mobile of context.mobileSockets) {
        mobile.send(payload);
      }
      return;
    }

    if (message.type === "chat_reply") {
      const reply = message as ChatReplyMessage;
      if (!reply.workspaceId || !reply.provider || !reply.content) {
        return;
      }
      const entry: ChatEntry = {
        id: randomUUID(),
        deviceId,
        workspaceId: reply.workspaceId,
        provider: reply.provider,
        role: "assistant",
        content: reply.content,
        promptId: reply.promptId,
        createdAt: new Date().toISOString()
      };
      const chatKey = keyFor(deviceId, reply.workspaceId, reply.provider);
      history.set(chatKey, [...(history.get(chatKey) || []), entry]);
      for (const mobile of context.mobileSockets) {
        mobile.send(JSON.stringify({ type: "chat_reply", protocol: PROTOCOL_VERSION, entry }));
      }
    }
  });

  socket.on("close", () => {
    if (clientKind === "desktop") {
      // Remove this socket from all workspace entries
      for (const [wsId, ws] of context.desktopSockets) {
        if (ws === socket) {
          context.desktopSockets.delete(wsId);
          // Remove workspaces belonging to this window
          context.workspaces = context.workspaces.filter((w) => w.id !== wsId);
        }
      }
      return;
    }
    context.mobileSockets.delete(socket);
  });
});

server.on("upgrade", (req, socket, head) => {
  if (!req.url) {
    socket.destroy();
    return;
  }

  const url = new URL(req.url, publicBaseUrl);
  const kind = url.pathname === "/v1/connect/desktop"
    ? "desktop"
    : url.pathname === "/v1/connect/mobile"
      ? "mobile"
      : undefined;

  if (!kind) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, kind);
  });
});

server.listen(port, () => {
  console.log(`Relay backend listening on ${publicBaseUrl}`);
});
