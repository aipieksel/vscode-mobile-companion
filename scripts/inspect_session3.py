#!/usr/bin/env python3
"""Process session JSONL chronologically to understand response data flow."""
import json, os, glob

base = os.path.expanduser(
    "~/Library/Application Support/Code/User/workspaceStorage/"
    "cf55ca1d171f6da737f5247bca9469a9/chatSessions"
)
files = sorted(glob.glob(os.path.join(base, "*.jsonl")), key=os.path.getmtime, reverse=True)
session_path = files[0]

with open(session_path) as f:
    lines = [json.loads(l) for l in f if l.strip()]

# Process chronologically, tracking state
current_requests = []  # mirrors VS Code's request array
all_seen_requests = {}  # requestId -> {user, assistant_text, timestamp}

for line in lines:
    k = line.get("k", [])
    kind = line.get("kind")

    # Full requests snapshot
    if kind == 2 and k == ["requests"]:
        current_requests = line.get("v", [])
        for i, req in enumerate(current_requests):
            rid = req.get("requestId", "")
            if not rid:
                continue
            user = req.get("message", {}).get("text", "")
            resp = req.get("response", [])
            text = ""
            for p in resp:
                if isinstance(p.get("value"), str):
                    text += p["value"]
                if isinstance(p.get("content"), dict) and isinstance(p["content"].get("value"), str):
                    text += p["content"]["value"]
            if rid not in all_seen_requests:
                all_seen_requests[rid] = {"user": user, "assistant": text, "timestamp": req.get("timestamp", 0)}
            else:
                if user:
                    all_seen_requests[rid]["user"] = user
                if len(text) > len(all_seen_requests[rid].get("assistant", "")):
                    all_seen_requests[rid]["assistant"] = text

    # Incremental response update
    if kind == 2 and len(k) >= 3 and k[0] == "requests" and isinstance(k[1], int) and k[2] == "response":
        idx = k[1]
        if idx < len(current_requests):
            rid = current_requests[idx].get("requestId", "")
            if rid and isinstance(line.get("v"), list):
                text = ""
                for p in line["v"]:
                    if isinstance(p.get("value"), str):
                        text += p["value"]
                    if isinstance(p.get("content"), dict) and isinstance(p["content"].get("value"), str):
                        text += p["content"]["value"]
                if rid in all_seen_requests and len(text) > len(all_seen_requests[rid].get("assistant", "")):
                    all_seen_requests[rid]["assistant"] = text
        else:
            # Index out of range - snapshot was reset
            pass

print(f"Total unique requests seen: {len(all_seen_requests)}")
print()

with_assistant = sum(1 for r in all_seen_requests.values() if r.get("assistant"))
print(f"With assistant text: {with_assistant}")
print(f"Without assistant text: {len(all_seen_requests) - with_assistant}")
print()

# Show all requests sorted by timestamp
sorted_reqs = sorted(all_seen_requests.items(), key=lambda x: x[1].get("timestamp", 0))
for rid, data in sorted_reqs:
    user_preview = data["user"][:60].replace("\n", " ")
    asst_len = len(data.get("assistant", ""))
    asst_preview = data.get("assistant", "")[:80].replace("\n", " ") if asst_len else "(none)"
    print(f"  [{asst_len:5d} chars] user='{user_preview}' -> {asst_preview}")
