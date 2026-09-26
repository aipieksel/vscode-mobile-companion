#!/usr/bin/env node
/**
 * End-to-end relay test: exercises pairing, desktop WS connect,
 * desktop_hello, mobile WS connect, send_prompt, chat_reply, and history.
 *
 * Usage: node scripts/e2e-relay-test.js
 * Prereq: relay backend running on http://127.0.0.1:8787
 */

const http = require("http");
const WebSocket = require("ws");

const BASE = "http://127.0.0.1:8787";
const WS_BASE = "ws://127.0.0.1:8787";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers || {})
      }
    };
    const req = http.request(reqOpts, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function waitForMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS message timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(String(data)));
      } catch {
        resolve(String(data));
      }
    });
  });
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log("\n=== E2E Relay Test Suite ===\n");

  // ── Test 1: Health ──
  console.log("1. Health endpoint");
  const health = await fetch(`${BASE}/health`);
  assert(health.status === 200, "GET /health returns 200");
  assert(health.body.ok === true, "health.ok is true");

  // ── Test 2: Pair start ──
  console.log("\n2. Pairing start");
  const pairRes = await fetch(`${BASE}/v1/pair/start`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token-123" },
    body: { deviceName: "Test Mac", platform: "darwin" }
  });
  assert(pairRes.status === 200, "POST /v1/pair/start returns 200");
  assert(typeof pairRes.body.code === "string", "pairing code is a string");
  assert(pairRes.body.code.length === 6, "pairing code is 6 digits");
  assert(typeof pairRes.body.deviceId === "string", "deviceId returned");
  assert(pairRes.body.approved === false, "not yet approved");

  const { code, deviceId, userToken } = pairRes.body;
  console.log(`   code=${code} deviceId=${deviceId.slice(0, 8)}...`);

  // ── Test 3: Desktop WS connect ──
  console.log("\n3. Desktop WebSocket connect");
  const workspaceId = "ws-test-001";
  const desktopWs = new WebSocket(
    `${WS_BASE}/v1/connect/desktop?deviceId=${deviceId}&workspaceId=${workspaceId}`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  await waitForOpen(desktopWs);
  assert(desktopWs.readyState === WebSocket.OPEN, "Desktop WS connected");

  // ── Test 4: Desktop sends desktop_hello ──
  console.log("\n4. Desktop sends desktop_hello");
  const helloMsg = {
    type: "desktop_hello",
    protocol: 1,
    deviceId,
    workspaceId,
    workspaces: [
      { id: workspaceId, name: "vscode-mobile", path: "/test/vscode-mobile" }
    ],
    capabilities: {
      providers: ["copilot"],
      connected: true,
      sessionSyncHealthy: true,
      providersAvailable: ["copilot"]
    }
  };
  desktopWs.send(JSON.stringify(helloMsg));
  await sleep(200);

  // Verify workspaces endpoint reflects the hello
  const wsRes = await fetch(`${BASE}/v1/workspaces?deviceId=${deviceId}`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert(wsRes.status === 200, "GET /v1/workspaces returns 200");
  assert(wsRes.body.workspaces.length >= 1, "workspaces has >= 1 entry");
  assert(wsRes.body.workspaces[0].name === "vscode-mobile", "workspace name matches");
  assert(wsRes.body.capabilities !== null, "capabilities returned");

  // ── Test 5: Pair approve ──
  console.log("\n5. Pair approve");

  // Set up listener BEFORE approve fires
  const pairApprovedPromise = waitForMessage(desktopWs, 8000);

  const approveRes = await fetch(`${BASE}/v1/pair/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: { code }
  });
  assert(approveRes.status === 200, "POST /v1/pair/approve returns 200");
  assert(approveRes.body.ok === true, "approve ok");

  // Desktop should receive pair_approved
  const pairApprovedMsg = await pairApprovedPromise;
  assert(pairApprovedMsg.type === "pair_approved", "desktop received pair_approved");
  assert(pairApprovedMsg.protocol === 1, "pair_approved has protocol version");

  // ── Test 6: Mobile WS connect ──
  console.log("\n6. Mobile WebSocket connect");
  const mobileWs = new WebSocket(
    `${WS_BASE}/v1/connect/mobile?deviceId=${deviceId}`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  await waitForOpen(mobileWs);
  assert(mobileWs.readyState === WebSocket.OPEN, "Mobile WS connected");

  // ── Test 7: Desktop sends status update ──
  console.log("\n7. Desktop sends desktop_status");

  // Set up listener BEFORE send
  const mobileStatusPromise = waitForMessage(mobileWs, 8000);

  const statusMsg = {
    type: "desktop_status",
    protocol: 1,
    deviceId,
    workspaceId,
    workspaces: [
      { id: workspaceId, name: "vscode-mobile", path: "/test/vscode-mobile" }
    ],
    capabilities: {
      providers: ["copilot"],
      connected: true,
      sessionSyncHealthy: true,
      providersAvailable: ["copilot"]
    }
  };
  desktopWs.send(JSON.stringify(statusMsg));

  // Mobile should receive the status
  const mobileStatus = await mobileStatusPromise;
  assert(mobileStatus.type === "desktop_status", "mobile received desktop_status");
  assert(mobileStatus.workspaces.length === 1, "mobile gets workspace list");

  // ── Test 8: Send prompt via HTTP ──
  console.log("\n8. Send prompt (HTTP -> desktop WS)");
  const promptContent = "What is a closure in JavaScript?";

  // Set up listener BEFORE send
  const sendPromptPromise = waitForMessage(desktopWs, 8000);

  const sendRes = await fetch(`${BASE}/v1/chats/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: {
      deviceId,
      workspaceId,
      provider: "copilot",
      content: promptContent
    }
  });
  assert(sendRes.status === 202, "POST /v1/chats/send returns 202 Accepted");
  assert(sendRes.body.queued === true, "prompt is queued");
  assert(typeof sendRes.body.id === "string", "promptId returned");

  const promptId = sendRes.body.id;
  console.log(`   promptId=${promptId.slice(0, 8)}...`);

  // Desktop should receive send_prompt via WS
  const sendPromptMsg = await sendPromptPromise;
  assert(sendPromptMsg.type === "send_prompt", "desktop received send_prompt");
  assert(sendPromptMsg.protocol === 1, "send_prompt has protocol version");
  assert(sendPromptMsg.content === promptContent, "prompt content matches");
  assert(sendPromptMsg.workspaceId === workspaceId, "workspaceId matches");
  assert(sendPromptMsg.provider === "copilot", "provider matches");
  assert(sendPromptMsg.promptId === promptId, "promptId matches");

  // ── Test 9: Desktop sends chat_reply ──
  console.log("\n9. Desktop sends chat_reply");
  const replyContent = "A closure is a function that retains access to its lexical scope...";

  // Set up listener BEFORE send
  const mobileReplyPromise = waitForMessage(mobileWs, 8000);

  const replyMsg = {
    type: "chat_reply",
    protocol: 1,
    workspaceId,
    provider: "copilot",
    content: replyContent,
    promptId,
    isComplete: true
  };
  desktopWs.send(JSON.stringify(replyMsg));

  // Mobile should receive the reply
  const mobileReply = await mobileReplyPromise;
  assert(mobileReply.type === "chat_reply", "mobile received chat_reply");
  assert(mobileReply.entry.content === replyContent, "reply content matches");
  assert(mobileReply.entry.role === "assistant", "reply role is assistant");
  assert(mobileReply.entry.promptId === promptId, "reply promptId matches");
  assert(mobileReply.entry.provider === "copilot", "reply provider matches");

  // ── Test 10: Chat history ──
  console.log("\n10. Chat history");
  const histRes = await fetch(
    `${BASE}/v1/chats/history?deviceId=${deviceId}&workspaceId=${workspaceId}&provider=copilot`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  assert(histRes.status === 200, "GET /v1/chats/history returns 200");
  assert(histRes.body.entries.length === 2, "history has 2 entries (user + assistant)");

  const userEntry = histRes.body.entries.find((e) => e.role === "user");
  const assistantEntry = histRes.body.entries.find((e) => e.role === "assistant");
  assert(userEntry && userEntry.content === promptContent, "user entry content correct");
  assert(assistantEntry && assistantEntry.content === replyContent, "assistant entry content correct");
  assert(assistantEntry && assistantEntry.promptId === promptId, "assistant entry has promptId");

  // ── Test 11: Second workspace (multi-window) ──
  console.log("\n11. Multi-workspace routing");
  const ws2Id = "ws-test-002";
  const desktop2Ws = new WebSocket(
    `${WS_BASE}/v1/connect/desktop?deviceId=${deviceId}&workspaceId=${ws2Id}`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  await waitForOpen(desktop2Ws);
  assert(desktop2Ws.readyState === WebSocket.OPEN, "Second desktop WS connected");

  // Send hello from second workspace
  desktop2Ws.send(JSON.stringify({
    type: "desktop_hello",
    protocol: 1,
    deviceId,
    workspaceId: ws2Id,
    workspaces: [
      { id: ws2Id, name: "other-project", path: "/test/other-project" }
    ],
    capabilities: { providers: ["copilot"], connected: true }
  }));
  await sleep(200);

  // Send prompt targeting first workspace - should go to desktop1
  const ws1MsgPromise = waitForMessage(desktopWs, 8000);
  const send1 = await fetch(`${BASE}/v1/chats/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: { deviceId, workspaceId, provider: "copilot", content: "Prompt for ws1" }
  });
  assert(send1.status === 202, "Prompt to ws1 accepted");

  const ws1Msg = await ws1MsgPromise;
  assert(ws1Msg.type === "send_prompt", "ws1 desktop received prompt");
  assert(ws1Msg.workspaceId === workspaceId, "ws1 prompt targets ws1");

  // Send prompt targeting second workspace - should go to desktop2
  const ws2MsgPromise = waitForMessage(desktop2Ws, 8000);
  const send2 = await fetch(`${BASE}/v1/chats/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: { deviceId, workspaceId: ws2Id, provider: "copilot", content: "Prompt for ws2" }
  });
  assert(send2.status === 202, "Prompt to ws2 accepted");

  const ws2Msg = await ws2MsgPromise;
  assert(ws2Msg.type === "send_prompt", "ws2 desktop received prompt");
  assert(ws2Msg.workspaceId === ws2Id, "ws2 prompt targets ws2");

  // ── Test 12: Send to unknown workspace ──
  console.log("\n12. Send to non-connected workspace");
  const send3 = await fetch(`${BASE}/v1/chats/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: { deviceId, workspaceId: "unknown-ws", provider: "copilot", content: "hello" }
  });
  assert(send3.status === 409, "Prompt to unknown workspace returns 409");
  assert(send3.body.error !== undefined, "error message returned");

  // ── Test 13: Disconnect desktop, verify cleanup ──
  console.log("\n13. Desktop disconnect cleanup");
  desktop2Ws.close();
  await sleep(300);

  const send4 = await fetch(`${BASE}/v1/chats/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: { deviceId, workspaceId: ws2Id, provider: "copilot", content: "after disconnect" }
  });
  assert(send4.status === 409, "Prompt to disconnected workspace returns 409");

  // First workspace still works
  const ws1StillAlivePromise = waitForMessage(desktopWs, 8000);
  const send5 = await fetch(`${BASE}/v1/chats/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
    body: { deviceId, workspaceId, provider: "copilot", content: "still alive" }
  });
  assert(send5.status === 202, "Prompt to still-connected ws1 accepted");
  await ws1StillAlivePromise; // consume the message

  // ── Cleanup ──
  desktopWs.close();
  mobileWs.close();
  await sleep(200);

  // ── Summary ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(2);
});
