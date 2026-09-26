#!/usr/bin/env python3
"""Check incremental response updates and their part types in detail."""
import json, os, glob

base = os.path.expanduser(
    "~/Library/Application Support/Code/User/workspaceStorage/"
    "cf55ca1d171f6da737f5247bca9469a9/chatSessions"
)
files = sorted(glob.glob(os.path.join(base, "*.jsonl")), key=os.path.getmtime, reverse=True)
session_path = files[0]

with open(session_path) as f:
    lines = [json.loads(l) for l in f if l.strip()]

# Track through all lines chronologically
current_requests = []
max_requests_seen = 0

for line in lines:
    k = line.get("k", [])
    kind = line.get("kind")
    if kind == 2 and k == ["requests"]:
        current_requests = line.get("v", [])
        max_requests_seen = max(max_requests_seen, len(current_requests))

print(f"Max requests array size ever: {max_requests_seen}")

# Process again, this time tracking response updates and what size the array was
current_requests = []
inc_updates = []  # (line_idx, array_idx, was_valid, part_kinds, total_text)

for li, line in enumerate(lines):
    k = line.get("k", [])
    kind = line.get("kind")
    if kind == 2 and k == ["requests"]:
        current_requests = line.get("v", [])
    elif kind == 2 and len(k) >= 3 and k[0] == "requests" and isinstance(k[1], int) and k[2] == "response":
        idx = k[1]
        valid = idx < len(current_requests)
        parts = line.get("v", [])
        kinds_set = set()
        total_text = 0
        for p in parts:
            if p.get("kind"):
                kinds_set.add(p["kind"])
            if isinstance(p.get("value"), str):
                total_text += len(p["value"])
            if isinstance(p.get("content"), dict) and isinstance(p["content"].get("value"), str):
                total_text += len(p["content"]["value"])
        rid = current_requests[idx].get("requestId", "?")[:12] if valid else "STALE"
        inc_updates.append((li, idx, valid, sorted(kinds_set), total_text, rid))

print(f"\nIncremental response updates: {len(inc_updates)}")
valid_count = sum(1 for u in inc_updates if u[2])
stale_count = sum(1 for u in inc_updates if not u[2])
print(f"  Valid (index in range): {valid_count}")
print(f"  Stale (index out of range): {stale_count}")

# Show all updates
print("\nAll incremental updates:")
for li, idx, valid, kinds, text, rid in inc_updates:
    marker = "OK" if valid else "STALE"
    print(f"  line={li:3d} req[{idx:2d}] {marker:5s} rid={rid:12s} kinds={kinds} text={text}")

# For the latest request that has response data, show the part structure in detail
print("\n--- Latest request response parts (from last snapshot) ---")
for line in reversed(lines):
    if line.get("kind") == 2 and line.get("k") == ["requests"]:
        for req in line["v"]:
            resp = req.get("response", [])
            if resp:
                print(f"Request: {req.get('requestId','?')[:20]}")
                print(f"User: {req.get('message',{}).get('text','')[:80]}")
                print(f"Response parts: {len(resp)}")
                for i, p in enumerate(resp[:10]):
                    print(f"  Part {i}:")
                    for key in sorted(p.keys()):
                        val = p[key]
                        if isinstance(val, str) and len(val) > 100:
                            val = val[:100] + "..."
                        elif isinstance(val, dict):
                            if "value" in val and isinstance(val["value"], str) and len(val["value"]) > 100:
                                val = {k: (v[:100]+"..." if isinstance(v,str) and len(v)>100 else v) for k,v in val.items()}
                        print(f"    {key}: {val}")
        break
