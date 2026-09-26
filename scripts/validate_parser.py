#!/usr/bin/env python3
"""Validate the new parser logic against the session file."""
import json, os, glob

base = os.path.expanduser(
    "~/Library/Application Support/Code/User/workspaceStorage/"
    "cf55ca1d171f6da737f5247bca9469a9/chatSessions"
)
files = sorted(glob.glob(os.path.join(base, "*.jsonl")), key=os.path.getmtime, reverse=True)
session_path = files[0]

with open(session_path) as f:
    lines = [json.loads(l) for l in f if l.strip()]

requests_by_id = {}
index_to_id = {}

skip_kinds = {"mcpServersStarting", "undoStop", "codeblockUri", "progressTaskSerialized"}

def extract(resp):
    text = ""
    for p in resp:
        kind = p.get("kind")
        val = p.get("value", "")
        if isinstance(val, str) and val.strip() and kind not in skip_kinds:
            text += val
        c = p.get("content")
        if isinstance(c, dict) and isinstance(c.get("value"), str) and c["value"].strip():
            text += c["value"]
    return text.strip()

for line in lines:
    k = line.get("k", [])
    kind = line.get("kind")
    if kind == 2 and k == ["requests"] and isinstance(line.get("v"), list):
        for i, req in enumerate(line["v"]):
            rid = req.get("requestId")
            if not rid:
                continue
            index_to_id[i] = rid
            user = req.get("message", {}).get("text", "")
            asst = extract(req.get("response", []))
            existing = requests_by_id.get(rid, {})
            requests_by_id[rid] = {
                "user": user or existing.get("user", ""),
                "assistant": asst if len(asst) > len(existing.get("assistant", "")) else existing.get("assistant", ""),
                "timestamp": req.get("timestamp", existing.get("timestamp", 0)),
            }
    elif kind == 2 and len(k) >= 3 and k[0] == "requests" and isinstance(k[1], int) and k[2] == "response":
        idx = k[1]
        rid = index_to_id.get(idx)
        if rid and isinstance(line.get("v"), list):
            asst = extract(line["v"])
            if asst and rid in requests_by_id:
                if len(asst) > len(requests_by_id[rid].get("assistant", "")):
                    requests_by_id[rid]["assistant"] = asst

total = len(requests_by_id)
with_asst = sum(1 for r in requests_by_id.values() if r.get("assistant"))
print(f"Total: {total}, With assistant: {with_asst}, Without: {total - with_asst}")
print(f"Index-to-ID map size: {len(index_to_id)}")
