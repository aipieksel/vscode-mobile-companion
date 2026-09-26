#!/usr/bin/env python3
"""Test cumulative index mapping approach."""
import json, os, glob

base = os.path.expanduser(
    "~/Library/Application Support/Code/User/workspaceStorage/"
    "cf55ca1d171f6da737f5247bca9469a9/chatSessions"
)
files = sorted(glob.glob(os.path.join(base, "*.jsonl")), key=os.path.getmtime, reverse=True)
session_path = files[0]

with open(session_path) as f:
    lines = [json.loads(l) for l in f if l.strip()]

# Strategy: maintain cumulative index across all snapshots
# Each snapshot replaces the "current" array, but incremental updates
# use the GLOBAL cumulative index (total requests ever seen).
requests_by_id = {}
index_to_id = {}  # global_index -> requestId
cumulative_index = 0  # running total of unique requests assigned
seen_request_ids = set()  # avoid double-counting

# Also keep the snapshot-based approach as fallback
snapshot_ids = {}  # snapshot_index -> requestId (from latest snapshot)

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
        snapshot_ids.clear()
        for i, req in enumerate(line["v"]):
            rid = req.get("requestId")
            if not rid:
                continue
            snapshot_ids[i] = rid
            
            # For new requests, assign cumulative index
            if rid not in seen_request_ids:
                index_to_id[cumulative_index] = rid
                cumulative_index += 1
                seen_request_ids.add(rid)
            
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
        if not rid:
            # Try snapshot-local index as fallback
            rid = snapshot_ids.get(idx)
        if rid and isinstance(line.get("v"), list):
            asst = extract(line["v"])
            if asst and rid in requests_by_id:
                if len(asst) > len(requests_by_id[rid].get("assistant", "")):
                    requests_by_id[rid]["assistant"] = asst

total = len(requests_by_id)
with_asst = sum(1 for r in requests_by_id.values() if r.get("assistant"))
print(f"Total: {total}, With assistant: {with_asst}, Without: {total - with_asst}")
print(f"Index-to-ID map: {len(index_to_id)} entries, max index: {max(index_to_id.keys()) if index_to_id else 'N/A'}")

# Show which requests have/don't have assistant text
print("\nRequests without assistant text:")
for rid, data in sorted(requests_by_id.items(), key=lambda x: x[1]["timestamp"]):
    if not data.get("assistant"):
        user_preview = data["user"][:60].replace("\n", " ")
        print(f"  {rid[:12]}: '{user_preview}'")
