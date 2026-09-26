(() => {
  "use strict";

  const BASE_PORT = 8767;
  const MAX_PORT_SCAN = 6;
  const POLL_MS = 3000;

  const state = {
    provider: "copilot",
    messages: [],
    health: null,
    workspaceInfo: null,
    recentPrompts: [],
    pollTimer: null,
    apiBase: "http://127.0.0.1:" + BASE_PORT,
    activePort: BASE_PORT,
    discoveredWindows: []
  };

  const els = {
    bootSpinner: byId("boot-spinner"),
    bootSpinnerStatus: byId("boot-spinner-status"),
    currentWorkspace: byId("currentWorkspace"),
    workspaceSelect: byId("workspace-select"),
    chatMessages: byId("chatMessages"),
    promptInput: byId("promptInput"),
    sendBtn: byId("sendBtn"),
    refreshWindowsBtn: byId("refresh-windows-btn"),
    topProviderCopilotBtn: byId("top-provider-copilot-btn"),
    runtimeStatusHeading: byId("runtime-status-heading"),
    runtimeStatusDetail: byId("runtime-status-detail"),
    runtimeStatusStateBtn: byId("runtime-status-state-btn"),
    runtimeStatusStopBtn: byId("runtime-status-stop-btn"),
    runtimeStatusDot: byId("runtime-status-dot"),
    sidebarHealthValue: byId("sidebar-health-value"),
    sidebarHealthDot: byId("sidebar-health-dot"),
    activeSessionsValue: byId("active-sessions-value"),
    sidebarStatWindowsValue: byId("sidebar-stat-windows-value"),
    sidebarStatToolsValue: byId("sidebar-stat-tools-value"),
    recentRequestsList: byId("recent-requests-list"),
    modeVscodeBtn: byId("mode-vscode-btn"),
    menuToggle: byId("menuToggle"),
    sidebar: byId("sidebar"),
    backdrop: byId("app-shell-backdrop"),
    actionBtn: byId("actionBtn"),
    recordBtn: byId("recordBtn"),
    clearPromptBtn: byId("clearPromptBtn"),
    clearInputBtn: byId("clearInputBtn"),
    promptPrevBtn: byId("promptPrevBtn"),
    promptNextBtn: byId("promptNextBtn"),
    providerButtons: [
      byId("provider-copilot-btn"),
      byId("provider-codex-btn"),
      byId("provider-opencode-btn")
    ].filter(Boolean)
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function setBootStatus(text) {
    if (els.bootSpinnerStatus) {
      els.bootSpinnerStatus.textContent = text;
    }
  }

  function dismissBootSpinner() {
    if (els.bootSpinner) {
      els.bootSpinner.classList.add("is-hidden");
      els.bootSpinner.style.display = "none";
    }
  }

  function markConnected(connected) {
    const detail = connected ? "Extension API ready" : "Extension API unavailable";
    const heading = connected ? "Desktop extension online" : "Waiting for extension";
    const status = connected ? "Live" : "Offline";
    const dotColor = connected ? "var(--success)" : "var(--danger)";

    if (els.runtimeStatusHeading) els.runtimeStatusHeading.textContent = heading;
    if (els.runtimeStatusDetail) els.runtimeStatusDetail.textContent = detail;
    if (els.runtimeStatusStateBtn) els.runtimeStatusStateBtn.textContent = status;
    if (els.sidebarHealthValue) els.sidebarHealthValue.textContent = status;
    if (els.runtimeStatusDot) els.runtimeStatusDot.style.background = dotColor;
    if (els.sidebarHealthDot) els.sidebarHealthDot.style.background = dotColor;
  }

  function renderRecentPrompts() {
    if (!els.recentRequestsList) return;
    if (!state.recentPrompts.length) {
      els.recentRequestsList.textContent = "No recent requests";
      return;
    }

    els.recentRequestsList.innerHTML = state.recentPrompts
      .slice(-8)
      .reverse()
      .map((prompt) => `<div class="recent-request-item">${escapeHtml(prompt)}</div>`)
      .join("");
  }

  function renderProviderState() {
    if (els.topProviderCopilotBtn) {
      els.topProviderCopilotBtn.textContent = state.provider === "copilot" ? "Copilot" : "Codex";
    }

    for (const button of els.providerButtons) {
      if (!button) continue;
      const isCopilot = button.id === "provider-copilot-btn";
      const isCodex = button.id === "provider-codex-btn";
      const isActive = (state.provider === "copilot" && isCopilot) || (state.provider === "codex" && isCodex);
      button.classList.toggle("active", isActive);
      button.classList.toggle("is-active", isActive);
      if (button.id === "provider-opencode-btn") {
        button.classList.add("is-unavailable");
        button.setAttribute("disabled", "disabled");
      }
    }
  }

  async function discoverWindows() {
    const windows = [];
    const probes = [];
    for (let i = 0; i < MAX_PORT_SCAN; i++) {
      const port = BASE_PORT + i;
      const url = "http://127.0.0.1:" + port;
      probes.push(
        fetch(url + "/workspace-info", { signal: AbortSignal.timeout(800) })
          .then((r) => r.json())
          .then((info) => {
            if (info.workspaceName) {
              windows.push({ port, url, name: info.workspaceName, path: info.workspacePath, folders: info.folders || [] });
            }
          })
          .catch(() => {})
      );
    }
    await Promise.all(probes);
    windows.sort((a, b) => a.port - b.port);
    state.discoveredWindows = windows;
    return windows;
  }

  function switchToWindow(port) {
    state.activePort = port;
    state.apiBase = "http://127.0.0.1:" + port;
    state.messages = [];
    renderMessages();
    void refresh();
  }

  function renderWorkspaceInfo() {
    const windows = state.discoveredWindows || [];
    const currentPort = state.activePort;

    if (els.workspaceSelect) {
      if (windows.length > 1) {
        els.workspaceSelect.innerHTML = windows
          .map((w) => `<option value="${w.port}"${w.port === currentPort ? " selected" : ""}>${escapeHtml(w.name || "Window " + w.port)}</option>`)
          .join("");
        els.workspaceSelect.disabled = false;
      } else {
        const folders = state.workspaceInfo?.folders || [];
        els.workspaceSelect.innerHTML = folders
          .map((folder, index) => `<option value="${escapeHtml(folder.id || folder.name || String(index))}">${escapeHtml(folder.name || folder.path || "Workspace")}</option>`)
          .join("");
        els.workspaceSelect.disabled = true;
      }
    }

    if (els.currentWorkspace) {
      els.currentWorkspace.textContent = state.workspaceInfo?.workspaceName || "No workspace";
    }

    if (els.sidebarStatWindowsValue) {
      els.sidebarStatWindowsValue.textContent = String(windows.length || 1);
    }
  }

  function renderMessages() {
    if (!els.chatMessages) return;

    if (!state.messages.length) {
      els.chatMessages.innerHTML = `
        <div class="message assistant">
          <div class="message-avatar assistant">AI</div>
          <div class="message-content">
            <div class="message-header">
              <span class="message-sender">Codr Companion</span>
              <span class="message-time">waiting</span>
            </div>
            <div class="message-text">
              <p>Send a prompt from this browser page. It goes straight to the VS Code extension on <code>127.0.0.1:8767</code> without the Mac helper.</p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    els.chatMessages.innerHTML = state.messages.map((message) => {
      const role = message.role === "user" ? "user" : "assistant";
      const sender = message.role === "user" ? "You" : (message.provider || "Assistant");
      const time = message.timestamp ? new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      const avatar = message.role === "user" ? "You" : "AI";
      const paragraphs = escapeHtml(message.content || "")
        .split(/\n{2,}/)
        .map((chunk) => `<p>${chunk.replaceAll("\n", "<br>")}</p>`)
        .join("");

      return `
        <div class="message ${role}">
          <div class="message-avatar ${role === "assistant" ? "assistant" : ""}">${avatar}</div>
          <div class="message-content">
            <div class="message-header">
              <span class="message-sender">${escapeHtml(sender)}</span>
              <span class="message-time">${escapeHtml(time)}</span>
            </div>
            <div class="message-text">${paragraphs}</div>
          </div>
        </div>
      `;
    }).join("");

    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  async function fetchJson(path) {
    const res = await fetch(`${state.apiBase}${path}`);
    if (!res.ok) {
      throw new Error(`${path} failed with HTTP ${res.status}`);
    }
    return res.json();
  }

  async function refresh() {
    try {
      const [health, workspaceInfo, transcript] = await Promise.all([
        fetchJson("/health"),
        fetchJson("/workspace-info"),
        fetchJson("/transcript?limit=200")
      ]);

      state.health = health;
      state.workspaceInfo = workspaceInfo;
      const allMessages = Array.isArray(transcript.messages) ? transcript.messages : [];
      state.messages = allMessages

      if (els.activeSessionsValue) {
        els.activeSessionsValue.textContent = health.capabilities.connected ? "1" : "0";
      }
      if (els.sidebarStatToolsValue) {
        els.sidebarStatToolsValue.textContent = String((health.capabilities.providersAvailable || []).length);
      }

      markConnected(true);
      renderWorkspaceInfo();
      renderMessages();
      renderProviderState();
      dismissBootSpinner();
    } catch (error) {
      markConnected(false);
      setBootStatus(`Waiting for extension API: ${String(error)}`);
    }
  }

  async function sendPrompt() {
    const message = els.promptInput?.value.trim() || "";
    if (!message) return;

    if (els.sendBtn) els.sendBtn.setAttribute("disabled", "disabled");
    if (els.runtimeStatusStateBtn) els.runtimeStatusStateBtn.textContent = "Sending";
    if (els.runtimeStatusDetail) els.runtimeStatusDetail.textContent = "Submitting prompt to VS Code";

    try {
      const res = await fetch(`${state.apiBase}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          provider: state.provider
        })
      });

      if (!res.ok) {
        throw new Error(`send failed with HTTP ${res.status}`);
      }

      state.recentPrompts.push(message);
      renderRecentPrompts();

      if (els.promptInput) els.promptInput.value = "";
      await refresh();
    } catch (error) {
      if (els.runtimeStatusDetail) {
        els.runtimeStatusDetail.textContent = `Send failed: ${String(error)}`;
      }
    } finally {
      if (els.sendBtn) els.sendBtn.removeAttribute("disabled");
      if (els.runtimeStatusStateBtn) els.runtimeStatusStateBtn.textContent = "Live";
    }
  }

  function cycleProvider() {
    state.provider = state.provider === "copilot" ? "codex" : "copilot";
    renderProviderState();
  }

  function toggleSidebar(forceOpen) {
    const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !document.body.classList.contains("sidebar-open");
    document.body.classList.toggle("sidebar-open", shouldOpen);
  }

  function bindEvents() {
    if (els.sendBtn) {
      els.sendBtn.removeAttribute("disabled");
      els.sendBtn.addEventListener("click", () => {
        void sendPrompt();
      });
    }

    if (els.promptInput) {
      els.promptInput.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void sendPrompt();
        }
      });
      els.promptInput.addEventListener("input", () => {
        if (els.clearInputBtn) {
          els.clearInputBtn.classList.toggle("hidden", !els.promptInput.value);
        }
      });
    }

    if (els.refreshWindowsBtn) {
      els.refreshWindowsBtn.addEventListener("click", () => {
        void refresh();
      });
    }

    if (els.workspaceSelect) {
      els.workspaceSelect.addEventListener("change", () => {
        const val = els.workspaceSelect.value;
        const port = Number(val);
        if (port >= BASE_PORT && state.discoveredWindows.length > 1) {
          switchToWindow(port);
        }
      });
    }

    if (els.topProviderCopilotBtn) {
      els.topProviderCopilotBtn.addEventListener("click", cycleProvider);
    }

    const copilotBtn = byId("provider-copilot-btn");
    const codexBtn = byId("provider-codex-btn");
    if (copilotBtn) copilotBtn.addEventListener("click", () => { state.provider = "copilot"; renderProviderState(); });
    if (codexBtn) codexBtn.addEventListener("click", () => { state.provider = "codex"; renderProviderState(); });

    if (els.menuToggle) {
      els.menuToggle.style.display = "flex";
      els.menuToggle.addEventListener("click", () => toggleSidebar());
    }
    if (els.backdrop) {
      els.backdrop.addEventListener("click", () => toggleSidebar(false));
    }

    if (els.clearPromptBtn) {
      els.clearPromptBtn.addEventListener("click", () => {
        if (els.promptInput) els.promptInput.value = "";
      });
    }
    if (els.clearInputBtn) {
      els.clearInputBtn.addEventListener("click", () => {
        if (els.promptInput) {
          els.promptInput.value = "";
          els.clearInputBtn.classList.add("hidden");
        }
      });
    }

    for (const id of [
      "window-prev-btn",
      "window-next-btn",
      "runtime-status-stop-btn",
      "promptPrevBtn",
      "promptNextBtn",
      "actionBtn",
      "recordBtn",
      "download-logs-btn",
      "exportBtn",
      "logout-btn",
      "pushNotificationsToggle",
      "windowNavigationToggle",
      "debugLoggingToggle",
      "workdir-browse-btn",
      "workdir-save-btn"
    ]) {
      const el = byId(id);
      if (el instanceof HTMLButtonElement) {
        el.setAttribute("disabled", "disabled");
      }
    }

    if (els.modeVscodeBtn) {
      els.modeVscodeBtn.classList.add("active");
      els.modeVscodeBtn.textContent = "VSCode";
    }
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
  }

  function startWindowDiscovery() {
    void discoverWindows().then(() => renderWorkspaceInfo());
    setInterval(() => {
      void discoverWindows().then(() => renderWorkspaceInfo());
    }, POLL_MS * 5);
  }

  bindEvents();
  renderProviderState();
  renderRecentPrompts();
  setBootStatus("Connecting to the local VS Code extension...");
  void refresh();
  startPolling();
  startWindowDiscovery();
})();
