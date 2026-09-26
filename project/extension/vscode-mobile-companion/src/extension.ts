import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ChatReplyMessage, type DesktopHelloMessage, type DesktopStatusMessage, type SendPromptMessage } from "./protocol";

const BUILD_NUMBER = 10;

type Provider = "copilot";

interface PendingPrompt {
  promptId: string;
  promptText: string;
  normalizedText: string;
  provider: Provider;
  workspaceId: string;
  timestamp: number;
  matchedRequestId?: string;
}

interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  provider: Provider;
  workspaceId: string;
  isComplete?: boolean;
}

interface CompanionCapabilities {
  paired: boolean;
  connected: boolean;
  workspaceCount: number;
  providersAvailable: Provider[];
  sessionSyncHealthy: boolean;
}

interface PairingStartResponse {
  pairCode: string;
  pairUrl: string;
  deviceId: string;
  expiresAt: string;
}

let runtime: CodrCompanionRuntime | undefined;

interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  id?: string;
  isComplete?: boolean;
}

export function activate(context: vscode.ExtensionContext) {
  runtime = new CodrCompanionRuntime(context);
  void runtime.activate();
}

export function deactivate() {
  return runtime?.dispose();
}

class CodrCompanionRuntime {
  private readonly output = vscode.window.createOutputChannel("Codr Companion");
  private readonly transcript: TranscriptMessage[] = [];
  private readonly transcriptFilePath: string;
  private readonly dataRoot: string | null;
  private readonly transcriptIds = new Set<string>();
  private readonly workspaceHashes = this.resolveWorkspaceHashes();
  private readonly sessionCache = new Map<string, { user: string; assistant: string; timestamp: number; hasResult: boolean }>();
  private readonly parsedSessionFileCache = new Map<string, { mtimeMs: number; fileSize: number; messages: SessionMessage[] }>();
  private readonly parsedEditStateCache = new Map<string, { mtimeMs: number; fileSize: number; messages: SessionMessage[] }>();
  private readonly pendingPrompts = new Map<string, PendingPrompt>();
  private readonly trackedPrompts = new Map<string, PendingPrompt>();
  private server: http.Server | undefined;
  private socket: WebSocket | undefined;
  private sessionPollTimer: NodeJS.Timeout | undefined;
  private activePort = 0;
  private deviceId: string | undefined;
  private pairCode: string | undefined;
  private pairUrl: string | undefined;
  private authToken: string | undefined;
  private capabilities: CompanionCapabilities = {
    paired: false,
    connected: false,
    workspaceCount: 0,
    providersAvailable: ["copilot"],
    sessionSyncHealthy: true
  };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.transcriptFilePath = path.join(context.globalStorageUri.fsPath, "desktop-transcript.jsonl");
    this.dataRoot = this.resolveDataRoot();
  }

  async activate() {
    fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
    this.loadTranscript();
    this.authToken = await this.context.secrets.get("codrCompanion.authToken") ?? undefined;
    this.deviceId = await this.context.secrets.get("codrCompanion.deviceId") ?? undefined;
    this.capabilities.paired = Boolean(this.deviceId);
    this.capabilities.workspaceCount = this.workspaceFolders().length;

    this.context.subscriptions.push(
      this.output,
      vscode.commands.registerCommand("codrCompanion.startPairing", async () => this.startPairing()),
      vscode.commands.registerCommand("codrCompanion.connectBackend", async () => this.connectBackend(true)),
      vscode.commands.registerCommand("codrCompanion.showStatus", async () => this.showStatus()),
      vscode.commands.registerCommand("codrCompanion.sendPrompt", async () => this.sendPromptCommand()),
      vscode.commands.registerCommand("codrCompanion.newChat", async () => this.startNewChat()),
      { dispose: () => this.dispose() }
    );

    this.startLocalApiServer();
    this.startSessionPoller();
    void this.connectBackend(false);
    this.output.appendLine("Codr Companion activated");
  }

  dispose() {
    if (this.sessionPollTimer) {
      clearTimeout(this.sessionPollTimer);
      this.sessionPollTimer = undefined;
    }
    this.socket?.close();
    this.server?.close();
  }

  private workspaceFolders() {
    return (vscode.workspace.workspaceFolders || []).map((folder) => ({
      id: folder.name,
      name: folder.name,
      path: folder.uri.fsPath
    }));
  }

  private workspaceInfo() {
    const folders = this.workspaceFolders();
    return {
      workspaceName: folders[0]?.name || "",
      workspacePath: folders[0]?.path || "",
      folders
    };
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration("codrCompanion").get<T>(key, fallback);
  }

  private defaultProvider(): Provider {
    return this.config<Provider>("provider", "copilot");
  }

  private loadTranscript() {
    if (!fs.existsSync(this.transcriptFilePath)) {
      return;
    }
    for (const line of fs.readFileSync(this.transcriptFilePath, "utf8").split("\n").filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as TranscriptMessage;
        this.transcript.push(parsed);
        this.transcriptIds.add(parsed.id);
      } catch {
        this.output.appendLine(`Skipping malformed transcript line in ${this.transcriptFilePath}`);
      }
    }
  }

  private appendTranscript(message: TranscriptMessage) {
    if (this.transcriptIds.has(message.id)) {
      return;
    }
    this.transcript.push(message);
    this.transcriptIds.add(message.id);
    fs.appendFileSync(this.transcriptFilePath, `${JSON.stringify(message)}\n`);
    this.writeToWorkspaceChatLog(message);
  }

  private resolveDataRoot(): string | null {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const settingsPath = path.join(folder.uri.fsPath, "data", "settings.json");
      if (fs.existsSync(settingsPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
          if (raw.codrVsDirectory && fs.existsSync(raw.codrVsDirectory)) {
            return raw.codrVsDirectory;
          }
        } catch {
          // Ignore invalid settings and fall through to <workspace>/data.
        }
      }

      const dataDir = path.join(folder.uri.fsPath, "data");
      if (fs.existsSync(dataDir)) {
        return dataDir;
      }
    }

    return null;
  }

  private writeToWorkspaceChatLog(message: TranscriptMessage) {
    if (!this.dataRoot) {
      return;
    }

    const slug = message.workspaceId || this.workspaceFolders()[0]?.id || "workspace";
    const channel = "vscode";
    const provider = message.provider;
    const chatlogDir = path.join(this.dataRoot, "chatlogs", slug, channel, provider);
    const recentMarkdownPath = path.join(this.dataRoot, "chatlogs", slug, channel, `recent-${provider}.md`);
    const jsonlEntry = {
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      source: "vscode-mobile-companion"
    };

    try {
      fs.mkdirSync(chatlogDir, { recursive: true });
      fs.appendFileSync(path.join(chatlogDir, "chat.jsonl"), `${JSON.stringify(jsonlEntry)}\n`);

      const recentLine = `${message.role === "user" ? "## User" : "## Assistant"}\n\n${message.content}\n\n`;
      fs.appendFileSync(recentMarkdownPath, recentLine);
    } catch (error) {
      this.output.appendLine(`Failed writing workspace chatlog: ${String(error)}`);
    }
  }

  private startLocalApiServer() {
    const preferredPort = this.config<number>("localApiPort", 8767);
    const start = (port: number, retries: number) => {
      this.server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        if (req.method === "GET" && url.pathname === "/health") {
          const extVersion = this.context.extension?.packageJSON?.version || "unknown";
          this.json(res, 200, {
            status: "ok",
            port: this.activePort,
            version: extVersion,
            build: BUILD_NUMBER,
            capabilities: this.capabilities
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/workspace-info") {
          this.json(res, 200, this.workspaceInfo());
          return;
        }

        if (req.method === "GET" && url.pathname === "/capabilities") {
          this.json(res, 200, this.capabilities);
          return;
        }

        if (req.method === "GET" && (url.pathname === "/transcript" || url.pathname === "/copilot-session")) {
          void this.syncAssistantReplies();
          const myFolderIds = new Set(this.workspaceFolders().map((f) => f.id));
          let filtered = this.transcript.filter(
            (m) => myFolderIds.has(m.workspaceId)
          );
          filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
          const limit = parseInt(url.searchParams.get("limit") || "0", 10);
          if (limit > 0) {
            filtered = filtered.slice(-limit);
          }
          this.json(res, 200, {
            messages: filtered,
            sessionId: this.deviceId || "unpaired"
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/chat") {
          this.readBody(req).then(async (body) => {
            const payload = JSON.parse(body || "{}") as { message?: string; provider?: Provider };
            if (!payload.message?.trim()) {
              this.json(res, 400, { error: "message is required" });
              return;
            }
            try {
              await this.sendPrompt(payload.message, payload.provider || this.defaultProvider());
              this.json(res, 200, { ok: true });
            } catch (error) {
              this.json(res, 500, { error: String(error) });
            }
          }).catch((error) => {
            this.json(res, 500, { error: String(error) });
          });
          return;
        }

        this.json(res, 404, { error: "Not found" });
      });

      this.server.listen(port, "127.0.0.1", () => {
        this.activePort = port;
        this.output.appendLine(`Local desktop API listening on http://127.0.0.1:${port}`);
      });

      this.server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && retries > 0) {
          start(port + 1, retries - 1);
          return;
        }
        vscode.window.showErrorMessage(`Codr Companion local API failed: ${String(error)}`);
      });
    };

    start(preferredPort, 5);
  }

  private async startPairing() {
    const relayBaseUrl = await vscode.window.showInputBox({
      prompt: "Relay base URL",
      value: this.config<string>("relayBaseUrl", "http://127.0.0.1:8787"),
      ignoreFocusOut: true
    });
    if (!relayBaseUrl) {
      return;
    }

    const authToken = await vscode.window.showInputBox({
      prompt: "Account token for relay pairing",
      password: true,
      ignoreFocusOut: true
    });
    if (!authToken) {
      return;
    }

    this.authToken = authToken;
    await this.context.secrets.store("codrCompanion.authToken", authToken);

    const response = await this.postJson<PairingStartResponse>(
      `${relayBaseUrl}/v1/pair/start`,
      {
        deviceName: vscode.env.machineId,
        platform: process.platform,
        workspaces: this.workspaceFolders()
      },
      authToken
    );

    this.deviceId = response.deviceId;
    this.pairCode = response.pairCode;
    this.pairUrl = response.pairUrl;
    this.capabilities.paired = true;
    await this.context.secrets.store("codrCompanion.deviceId", response.deviceId);

    await vscode.env.clipboard.writeText(response.pairUrl);
    void vscode.env.openExternal(vscode.Uri.parse(response.pairUrl));
    this.output.appendLine(`Pairing started for device ${response.deviceId}`);
    vscode.window.showInformationMessage(`Pairing code ${response.pairCode} copied to clipboard.`);
    await this.connectBackend(true);
  }

  private async connectBackend(forceReconnect: boolean) {
    const relayBaseUrl = this.config<string>("relayBaseUrl", "http://127.0.0.1:8787");
    if (!this.authToken || !this.deviceId) {
      if (forceReconnect) {
        vscode.window.showWarningMessage("Start pairing first so the extension has a relay token and device ID.");
      }
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN && !forceReconnect) {
      return;
    }

    this.socket?.close();
    const socketUrl = relayBaseUrl.replace(/^http/, "ws");
    const wsId = this.workspaceFolders()[0]?.id || "_default";
    const connectUrl = `${socketUrl}/v1/connect/desktop?deviceId=${encodeURIComponent(this.deviceId)}&workspaceId=${encodeURIComponent(wsId)}`;
    this.socket = new WebSocket(connectUrl, {
      headers: {
        Authorization: `Bearer ${this.authToken}`
      }
    });

    this.socket.on("open", () => {
      this.capabilities.connected = true;
      this.sendDesktopHello();
      this.output.appendLine(`Connected to relay ${connectUrl}`);
    });

    this.socket.on("close", () => {
      this.capabilities.connected = false;
      this.output.appendLine("Relay connection closed");
    });

    this.socket.on("error", (error) => {
      this.capabilities.connected = false;
      this.output.appendLine(`Relay error: ${String(error)}`);
    });

    this.socket.on("message", async (data) => {
      try {
        const payload = JSON.parse(String(data)) as SendPromptMessage & { type: string };

        if (payload.type === "send_prompt" && payload.content) {
          await this.sendPrompt(payload.content, (payload.provider as Provider) || this.defaultProvider(), payload.workspaceId);
        }
      } catch (error) {
        this.output.appendLine(`Failed to process relay message: ${String(error)}`);
      }
    });
  }

  private sendDesktopHello() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const wsId = this.workspaceFolders()[0]?.id || "_default";
    const message: DesktopHelloMessage = {
      type: "desktop_hello",
      protocol: PROTOCOL_VERSION,
      deviceId: this.deviceId!,
      workspaceId: wsId,
      workspaces: this.workspaceFolders(),
      capabilities: this.capabilities
    };

    this.socket.send(JSON.stringify(message));
  }

  private publishDesktopStatus() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const wsId = this.workspaceFolders()[0]?.id || "_default";
    const message: DesktopStatusMessage = {
      type: "desktop_status",
      protocol: PROTOCOL_VERSION,
      deviceId: this.deviceId!,
      workspaceId: wsId,
      workspaces: this.workspaceFolders(),
      capabilities: this.capabilities
    };

    this.socket.send(JSON.stringify(message));
  }

  private async sendPromptCommand() {
    const prompt = await vscode.window.showInputBox({
      prompt: "Prompt to send from the mobile companion path",
      ignoreFocusOut: true
    });
    if (!prompt?.trim()) {
      return;
    }
    await this.sendPrompt(prompt, this.defaultProvider());
  }

  private async startNewChat() {
    await vscode.commands.executeCommand("workbench.action.chat.newChat");
    vscode.window.showInformationMessage("Opened a new VS Code chat session.");
  }

  private async showStatus() {
    const info = [
      `paired=${this.capabilities.paired}`,
      `connected=${this.capabilities.connected}`,
      `workspaceCount=${this.capabilities.workspaceCount}`,
      `providers=${this.capabilities.providersAvailable.join(",")}`,
      `sessionSyncHealthy=${this.capabilities.sessionSyncHealthy}`
    ].join(" | ");
    vscode.window.showInformationMessage(info);
  }

  private async sendPrompt(content: string, provider: Provider, workspaceId?: string) {
    const workspace = workspaceId || this.workspaceFolders()[0]?.id || "workspace";
    const trimmed = content.trim();
    const promptId = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const pending: PendingPrompt = {
      promptId,
      promptText: trimmed,
      normalizedText: this.normalizePromptText(trimmed),
      provider,
      workspaceId: workspace,
      timestamp: Date.now()
    };
    this.pendingPrompts.set(promptId, pending);

    await this.submitToProvider(provider, trimmed);

    const userMessage: TranscriptMessage = {
      id: promptId,
      role: "user",
      content: trimmed,
      timestamp: new Date().toISOString(),
      provider,
      workspaceId: workspace
    };
    this.appendTranscript(userMessage);
    this.publishDesktopStatus();
    void this.syncAssistantReplies();
  }

  private async submitToProvider(_provider: Provider, message: string) {
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query: message,
      isPartialQuery: false
    });
  }

  private readBody(req: http.IncomingMessage) {
    return new Promise<string>((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async postJson<T>(urlString: string, payload: unknown, authToken?: string): Promise<T> {
    const target = new URL(urlString);
    const body = JSON.stringify(payload);

    return new Promise<T>((resolve, reject) => {
      const req = http.request({
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        }
      }, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += String(chunk);
        });
        res.on("end", () => {
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(responseBody || `HTTP ${res.statusCode}`));
            return;
          }
          resolve(JSON.parse(responseBody) as T);
        });
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private startSessionPoller() {
    const pollOnce = async () => {
      try {
        this.expireStalePrompts();
        this.capSessionCache();
        await this.syncAssistantReplies();
        this.capabilities.sessionSyncHealthy = true;
      } catch (error) {
        this.capabilities.sessionSyncHealthy = false;
        this.output.appendLine(`Session sync failed: ${String(error)}`);
      } finally {
        this.sessionPollTimer = setTimeout(() => {
          void pollOnce();
        }, 2000);
      }
    };

    void pollOnce();
  }

  private expireStalePrompts() {
    const TTL = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    for (const [promptId, pending] of this.pendingPrompts) {
      if (now - pending.timestamp > TTL) {
        this.output.appendLine(`Expiring unmatched pending prompt ${promptId}`);
        this.pendingPrompts.delete(promptId);
      }
    }
    for (const [promptId, tracked] of this.trackedPrompts) {
      if (now - tracked.timestamp > TTL) {
        this.output.appendLine(`Expiring unresolved tracked prompt ${promptId}`);
        this.trackedPrompts.delete(promptId);
      }
    }
  }

  private capSessionCache() {
    const MAX_CACHE_SIZE = 200;
    if (this.sessionCache.size <= MAX_CACHE_SIZE) {
      return;
    }
    const sorted = Array.from(this.sessionCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = sorted.slice(0, sorted.length - MAX_CACHE_SIZE);
    for (const [key] of toRemove) {
      this.sessionCache.delete(key);
    }
  }

  private async syncAssistantReplies() {
    const sessionData = await this.readCopilotSession();

    // Step A: Match pending prompts to session requestIds by normalized text + timestamp proximity
    for (const [promptId, pending] of this.pendingPrompts) {
      if (pending.matchedRequestId) {
        continue;
      }
      for (const message of sessionData.messages) {
        if (message.role !== "user" || !message.content.trim()) {
          continue;
        }
        const normalizedSession = this.normalizePromptText(message.content);
        if (normalizedSession !== pending.normalizedText) {
          continue;
        }
        // Timestamp proximity: session message should be within 30s of when we sent
        const timeDiff = Math.abs(message.timestamp - pending.timestamp);
        if (timeDiff > 30_000) {
          continue;
        }
        pending.matchedRequestId = message.id || `anon-${message.timestamp}`;
        this.trackedPrompts.set(promptId, pending);
        this.pendingPrompts.delete(promptId);
        this.output.appendLine(`Matched pending prompt ${promptId} to session request ${pending.matchedRequestId}`);
        break;
      }
    }

    // Step B: Check tracked prompts for completed assistant replies
    for (const [promptId, tracked] of this.trackedPrompts) {
      if (!tracked.matchedRequestId) {
        continue;
      }

      const cacheEntry = this.sessionCache.get(tracked.matchedRequestId);
      if (!cacheEntry || !cacheEntry.assistant.trim()) {
        continue;
      }

      const assistantContent = cacheEntry.assistant.trim();
      const isComplete = cacheEntry.hasResult;

      // Only push completed replies (avoid pushing partial streams)
      if (!isComplete) {
        continue;
      }

      // Write assistant message to transcript + chatlog
      const transcriptMessage: TranscriptMessage = {
        id: `reply-${promptId}`,
        role: "assistant",
        content: assistantContent,
        timestamp: new Date().toISOString(),
        provider: tracked.provider,
        workspaceId: tracked.workspaceId,
        isComplete: true
      };

      if (!this.transcriptIds.has(transcriptMessage.id)) {
        this.appendTranscript(transcriptMessage);
        this.pushChatReply(tracked.workspaceId, tracked.provider, assistantContent, promptId, true);
        this.output.appendLine(`Pushed reply for prompt ${promptId} (${assistantContent.length} chars)`);
      }

      this.trackedPrompts.delete(promptId);
    }

    // Step C: Import/update session messages in transcript (user prompts + assistant replies)
    const myWsId = this.workspaceFolders()[0]?.id || "workspace";
    for (const [reqKey, data] of this.sessionCache) {
      if (data.user.trim()) {
        const userTranscriptId = `session-user-${reqKey}`;
        const cleanUser = this.cleanUserRequest(data.user.trim());
        if (!this.transcriptIds.has(userTranscriptId)) {
          this.appendTranscript({
            id: userTranscriptId,
            role: "user",
            content: cleanUser,
            timestamp: new Date(data.timestamp).toISOString(),
            provider: "copilot" as Provider,
            workspaceId: myWsId
          });
        } else {
          const existing = this.transcript.find((m) => m.id === userTranscriptId);
          if (existing && cleanUser.length > existing.content.length) {
            existing.content = cleanUser;
          }
        }
      }
      if (data.assistant.trim()) {
        const assistantTranscriptId = `session-assistant-${reqKey}`;
        if (!this.transcriptIds.has(assistantTranscriptId) && !this.transcriptIds.has(reqKey)) {
          this.appendTranscript({
            id: assistantTranscriptId,
            role: "assistant",
            content: data.assistant.trim(),
            timestamp: new Date(data.timestamp + 1).toISOString(),
            provider: "copilot" as Provider,
            workspaceId: myWsId,
            isComplete: true
          });
        } else {
          const existingId = this.transcriptIds.has(assistantTranscriptId) ? assistantTranscriptId : reqKey;
          const existing = this.transcript.find((m) => m.id === existingId);
          if (existing && data.assistant.trim()) {
            existing.content = data.assistant.trim();
            existing.isComplete = true;
          }
        }
      }
    }
  }

  private pushChatReply(workspaceId: string, provider: string, content: string, promptId: string, isComplete: boolean) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const message: ChatReplyMessage = {
      type: "chat_reply",
      protocol: PROTOCOL_VERSION,
      workspaceId,
      provider,
      content,
      promptId,
      isComplete
    };

    this.socket.send(JSON.stringify(message));
  }

  private normalizePromptText(text: string): string {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
  }

  private readCopilotSession(): { messages: SessionMessage[]; sessionId: string } {
    const codeStoragePath = path.join(this.resolveCodeUserDataPath(), "workspaceStorage");
    if (!fs.existsSync(codeStoragePath)) {
      throw new Error("workspaceStorage path not found");
    }

    const storageItems = this.workspaceHashes.length > 0
      ? this.workspaceHashes
      : fs.readdirSync(codeStoragePath);

    const sessionFiles: Array<{ workspaceId: string; sessionId: string; path: string; mtime: number }> = [];
    for (const workspaceId of storageItems) {
      const chatSessionsPath = path.join(codeStoragePath, workspaceId, "chatSessions");
      if (!fs.existsSync(chatSessionsPath)) {
        continue;
      }

      for (const file of this.safeReadDir(chatSessionsPath).filter((entry) => entry.endsWith(".jsonl"))) {
        const fullPath = path.join(chatSessionsPath, file);
        try {
          const stat = fs.statSync(fullPath);
          sessionFiles.push({
            workspaceId,
            sessionId: file.replace(/\.jsonl$/, ""),
            path: fullPath,
            mtime: stat.mtime.getTime()
          });
        } catch {
          // Ignore unreadable files.
        }
      }
    }

    if (sessionFiles.length === 0) {
      throw new Error("No Copilot session files found");
    }

    const newestSessions = sessionFiles.sort((a, b) => b.mtime - a.mtime).slice(0, 5);
    const mergedMessages: SessionMessage[] = [];
    let latestSessionId = newestSessions[0].sessionId;

    for (const session of newestSessions) {
      if (session.mtime >= newestSessions[0].mtime) {
        latestSessionId = session.sessionId;
      }
      mergedMessages.push(...this.parseCopilotSessionFile(session.path, session.sessionId, session.mtime));
    }

    for (const workspaceId of storageItems) {
      const editSessionsPath = path.join(codeStoragePath, workspaceId, "chatEditingSessions");
      if (!fs.existsSync(editSessionsPath)) {
        continue;
      }

      for (const sessionDir of this.safeReadDir(editSessionsPath)) {
        const stateFile = path.join(editSessionsPath, sessionDir, "state.json");
        try {
          const stat = fs.statSync(stateFile);
          if (Date.now() - stat.mtime.getTime() > 5 * 60 * 1000) {
            continue;
          }
          mergedMessages.push(...this.parseChatEditingState(stateFile, sessionDir, stat.mtime.getTime(), stat.size));
        } catch {
          // Ignore unreadable state files.
        }
      }
    }

    for (const message of mergedMessages) {
      const reqKey = message.id || `anon-${message.timestamp}`;
      const existing = this.sessionCache.get(reqKey);
      if (message.role === "user") {
        this.sessionCache.set(reqKey, {
          user: message.content || existing?.user || "",
          assistant: existing?.assistant || "",
          timestamp: Math.min(message.timestamp, existing?.timestamp ?? Number.POSITIVE_INFINITY),
          hasResult: existing?.hasResult || false
        });
      } else {
        const assistant = message.content || "";
        this.sessionCache.set(reqKey, {
          user: existing?.user || "",
          assistant: assistant || existing?.assistant || "",
          timestamp: existing?.timestamp || message.timestamp,
          hasResult: message.isComplete === true || existing?.hasResult || false
        });
      }
    }

    const messages: SessionMessage[] = [];
    for (const [reqKey, data] of this.sessionCache) {
      if (data.user) {
        messages.push({ role: "user", content: data.user, timestamp: data.timestamp, id: reqKey });
      }
      if (data.assistant) {
        messages.push({
          role: "assistant",
          content: data.assistant,
          timestamp: data.timestamp + 1,
          id: reqKey,
          isComplete: data.hasResult
        });
      }
    }

    messages.sort((a, b) => a.timestamp - b.timestamp);
    return { messages, sessionId: latestSessionId };
  }

  private parseCopilotSessionFile(sessionPath: string, sessionId: string, mtimeMs?: number): SessionMessage[] {
    const stat = fs.statSync(sessionPath);
    const effectiveMtime = mtimeMs ?? stat.mtime.getTime();
    const cached = this.parsedSessionFileCache.get(sessionPath);
    if (cached && cached.mtimeMs === effectiveMtime && cached.fileSize === stat.size) {
      return cached.messages;
    }

    const requestsById = new Map<string, { user: string; assistant: string; timestamp: number; hasResult: boolean }>();
    const completedRequestIds = new Set<string>();
    const globalIndexToId = new Map<number, string>();
    const seenRequestIds = new Set<string>();
    let nextGlobalIndex = 0;
    let snapshotLocalIds = new Map<number, string>();

    for (const line of fs.readFileSync(sessionPath, "utf8").trim().split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);

        if (entry.kind === 2 && Array.isArray(entry.k) && entry.k[0] === "requests" && entry.k.length === 1 && Array.isArray(entry.v)) {
          snapshotLocalIds = new Map();
          for (let i = 0; i < entry.v.length; i += 1) {
            const req = entry.v[i];
            const reqId = req.requestId;
            if (!reqId) {
              continue;
            }

            snapshotLocalIds.set(i, reqId);
            if (!seenRequestIds.has(reqId)) {
              globalIndexToId.set(nextGlobalIndex, reqId);
              seenRequestIds.add(reqId);
              nextGlobalIndex += 1;
            }

            const userText = req.message?.text || this.extractUserText(req.result?.metadata?.renderedUserMessage) || "";
            const assistantText = Array.isArray(req.response) ? this.extractAssistantResponse(req.response) : "";
            if (req.result && typeof req.result === "object" && Object.keys(req.result).length > 0) {
              completedRequestIds.add(reqId);
            }

            const existing = requestsById.get(reqId);
            requestsById.set(reqId, {
              user: userText || existing?.user || "",
              assistant: assistantText || existing?.assistant || "",
              timestamp: req.timestamp || existing?.timestamp || 0,
              hasResult: completedRequestIds.has(reqId) || existing?.hasResult || false
            });
          }
        }

        if (entry.kind === 2 && Array.isArray(entry.k) && entry.k[0] === "requests" && typeof entry.k[1] === "number" && entry.k[2] === "response" && Array.isArray(entry.v)) {
          const reqId = globalIndexToId.get(entry.k[1]) || snapshotLocalIds.get(entry.k[1]);
          if (!reqId) {
            continue;
          }
          const responseText = this.extractAssistantResponse(entry.v);
          const existing = requestsById.get(reqId);
          if (existing && responseText) {
            existing.assistant = responseText;
          }
        }

        if (entry.kind === 2 && Array.isArray(entry.k) && entry.k[0] === "requests" && typeof entry.k[1] === "number" && entry.k[2] === "result") {
          const reqId = globalIndexToId.get(entry.k[1]) || snapshotLocalIds.get(entry.k[1]);
          if (!reqId) {
            continue;
          }
          completedRequestIds.add(reqId);
          const existing = requestsById.get(reqId);
          if (existing) {
            existing.hasResult = true;
          }
        }
      } catch {
        // Ignore malformed jsonl lines.
      }
    }

    const messages: SessionMessage[] = [];
    for (const [reqId, data] of Array.from(requestsById.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)) {
      if (data.user) {
        messages.push({ role: "user", content: data.user, timestamp: data.timestamp, id: `${sessionId}:${reqId}` });
      }
      if (data.assistant) {
        messages.push({
          role: "assistant",
          content: data.assistant,
          timestamp: data.timestamp + 1,
          id: `${sessionId}:${reqId}`,
          isComplete: data.hasResult
        });
      }
    }

    this.parsedSessionFileCache.set(sessionPath, {
      mtimeMs: effectiveMtime,
      fileSize: stat.size,
      messages
    });
    return messages;
  }

  private parseChatEditingState(stateFile: string, sessionId: string, mtimeMs?: number, fileSize?: number): SessionMessage[] {
    const stat = fs.statSync(stateFile);
    const effectiveMtime = mtimeMs ?? stat.mtime.getTime();
    const effectiveSize = fileSize ?? stat.size;
    const cached = this.parsedEditStateCache.get(stateFile);
    if (cached && cached.mtimeMs === effectiveMtime && cached.fileSize === effectiveSize) {
      return cached.messages;
    }

    const stateData = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const requestsById = new Map<string, { user: string; assistant: string; timestamp: number }>();
    const entries = stateData?.timeline?.entries;

    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry.request) {
          continue;
        }
        const req = entry.request;
        const reqId = req.requestId || entry.id || `state-${Date.now()}`;
        const existing = requestsById.get(reqId);
        requestsById.set(reqId, {
          user: req.message?.text || existing?.user || "",
          assistant: Array.isArray(req.response) ? this.extractAssistantResponse(req.response) || existing?.assistant || "" : existing?.assistant || "",
          timestamp: req.timestamp || existing?.timestamp || Date.now()
        });
      }
    }

    if (Array.isArray(stateData?.recentSnapshot?.requests)) {
      for (const req of stateData.recentSnapshot.requests) {
        const reqId = req.requestId || `snap-${Date.now()}`;
        const existing = requestsById.get(reqId);
        requestsById.set(reqId, {
          user: req.message?.text || existing?.user || "",
          assistant: Array.isArray(req.response) ? this.extractAssistantResponse(req.response) || existing?.assistant || "" : existing?.assistant || "",
          timestamp: req.timestamp || existing?.timestamp || Date.now()
        });
      }
    }

    const messages: SessionMessage[] = [];
    for (const [reqId, data] of requestsById) {
      if (data.user) {
        messages.push({ role: "user", content: data.user, timestamp: data.timestamp, id: `edit:${sessionId}:${reqId}` });
      }
      if (data.assistant) {
        messages.push({ role: "assistant", content: data.assistant, timestamp: data.timestamp + 1, id: `edit:${sessionId}:${reqId}` });
      }
    }

    this.parsedEditStateCache.set(stateFile, {
      mtimeMs: effectiveMtime,
      fileSize: effectiveSize,
      messages
    });
    return messages;
  }

  private extractAssistantResponse(response: unknown[]): string {
    const skipKinds = new Set(["thinking", "toolInvocationSerialized", "mcpServersStarting", "undoStop", "codeblockUri", "progressTaskSerialized"]);
    let text = "";

    for (const part of response) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const value = part as { kind?: string; value?: unknown; content?: { value?: unknown }; inlineReference?: { name?: string } };
      if (value.kind && skipKinds.has(value.kind)) {
        continue;
      }
      // Inline references: extract symbol name wrapped in backticks
      if (value.kind === "inlineReference" && value.inlineReference?.name) {
        text += "`" + value.inlineReference.name + "`";
        continue;
      }
      if (typeof value.value === "string") {
        text += value.value;
      }
      if (typeof value.content?.value === "string" && value.content.value.trim()) {
        text += value.content.value;
      }
    }

    return text.replace(/```\s*```/g, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  private extractUserText(renderedMessage: unknown): string {
    if (!Array.isArray(renderedMessage)) {
      return "";
    }

    let fullText = "";
    for (const part of renderedMessage) {
      if (part && typeof part === "object" && (part as { type?: number; text?: unknown }).type === 1 && typeof (part as { text?: unknown }).text === "string") {
        fullText += (part as { text: string }).text;
      }
    }
    return this.cleanUserRequest(fullText);
  }

  private cleanUserRequest(text: string): string {
    // Extract <userRequest> content if present
    const userReqMatch = text.match(/<userRequest>([\s\S]*?)<\/userRequest>/);
    if (userReqMatch) {
      return userReqMatch[1].trim();
    }
    // Fallback: text after last closing context/reminder tag
    const lastTagIdx = Math.max(
      text.lastIndexOf("</context>"),
      text.lastIndexOf("</reminderInstructions>")
    );
    if (lastTagIdx >= 0) {
      const afterTag = text.substring(lastTagIdx).replace(/<\/[^>]+>/g, "").trim();
      if (afterTag.length > 0) {
        return afterTag;
      }
    }
    return text;
  }

  private resolveWorkspaceHashes(): string[] {
    const rootFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!rootFolder) {
      return [];
    }

    // Build match sets: both URIs and decoded filesystem paths
    const matchUris = new Set<string>();
    const matchPaths = new Set<string>();

    // Add all workspace folder URIs and paths
    for (const folder of vscode.workspace.workspaceFolders || []) {
      matchUris.add(folder.uri.toString());
      matchPaths.add(folder.uri.fsPath);
    }
    // Add the .code-workspace file if present
    if (vscode.workspace.workspaceFile) {
      matchUris.add(vscode.workspace.workspaceFile.toString());
      matchPaths.add(vscode.workspace.workspaceFile.fsPath);
    }

    const storagePath = path.join(this.resolveCodeUserDataPath(), "workspaceStorage");
    if (!fs.existsSync(storagePath)) {
      return [];
    }

    const matched: string[] = [];
    for (const hash of this.safeReadDir(storagePath)) {
      const workspaceJsonPath = path.join(storagePath, hash, "workspace.json");
      try {
        const raw = JSON.parse(fs.readFileSync(workspaceJsonPath, "utf8"));
        // Check both "folder" and "workspace" keys independently
        for (const key of ["folder", "workspace"] as const) {
          const uri = raw[key];
          if (!uri) { continue; }
          const uriStr = String(uri);
          const decoded = decodeURIComponent(uriStr.replace(/^file:\/\/\/?/, "/"));
          if (matchUris.has(uriStr) || matchPaths.has(decoded)) {
            matched.push(hash);
            break;
          }
        }
      } catch {
        // Ignore unreadable workspace descriptors.
      }
    }
    this.output.appendLine(`Resolved ${matched.length} workspace hashes: ${matched.join(", ")}`);
    return matched;
  }

  private resolveCodeUserDataPath(): string {
    if (process.platform === "darwin") {
      return path.join(process.env.HOME || "", "Library", "Application Support", "Code", "User");
    }
    if (process.platform === "win32") {
      return path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"), "Code", "User");
    }
    return path.join(process.env.HOME || "", ".config", "Code", "User");
  }

  private safeReadDir(dirPath: string): string[] {
    try {
      return fs.readdirSync(dirPath);
    } catch {
      return [];
    }
  }
}
