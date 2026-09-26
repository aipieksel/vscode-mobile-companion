#!/usr/bin/env python3
"""Inspect chatEditingSessions state.json for the current session."""
import json, os

state_file = os.path.expanduser(
    "~/Library/Application Support/Code/User/workspaceStorage/"
    "cf55ca1d171f6da737f5247bca9469a9/chatEditingSessions/"
    "272d3ef8-ef1f-4a69-a269-9c8a89768f1f/state.json"
)

with open(state_file) as f:
    state = json.load(f)

print("Top keys:", list(state.keys()))
print(f"File size: {os.path.getsize(state_file)} bytes")

# Check linearHistory
lh = state.get("linearHistory", {})
if lh:
    print("linearHistory keys:", list(lh.keys()))
    entries = lh.get("entries", [])
    print(f"linearHistory entries: {len(entries)}")
    if entries:
        for i, e in enumerate(entries[:3]):
            print(f"  Entry {i} keys: {list(e.keys())[:8]}")

# Check top-level shape
for key in sorted(state.keys()):
    val = state[key]
    if isinstance(val, list):
        print(f"  {key}: list[{len(val)}]")
    elif isinstance(val, dict):
        print(f"  {key}: dict[{len(val)} keys]")
    elif isinstance(val, str):
        print(f"  {key}: str({len(val)} chars)")
    else:
        print(f"  {key}: {type(val).__name__}")

# Now look at the JSONL file itself more carefully
# The key insight: we need to understand how the requests array shrinks
base = os.path.expanduser(
    "~/Library/Application Support/Code/User/workspaceStorage/"
    "cf55ca1d171f6da737f5247bca9469a9/chatSessions"
)
import glob
files = sorted(glob.glob(os.path.join(base, "*.jsonl")), key=os.path.getmtime, reverse=True)
session_path = files[0]

with open(session_path) as f:
    lines = [json.loads(l) for l in f if l.strip()]

# Track how the requests array changes over time
print("\n=== Request array size changes ===")
max_idx_seen = -1
for li, line in enumerate(lines):
    k = line.get("k", [])
    kind = line.get("kind")
    if kind == 2 and k == ["requests"] and isinstance(line.get("v"), list):
        sz = len(line["v"])
        ids = [r.get("requestId", "?")[:12] for r in line["v"]]
        print(f"  Line {li}: snapshot size={sz}, ids={ids}")
    elif kind == 2 and len(k) >= 3 and k[0] == "requests" and isinstance(k[1], int) and k[2] == "response":
        idx = k[1]
        if idx > max_idx_seen:
            max_idx_seen = idx
            print(f"  Line {li}: inc update for index {idx} (new max)")

print(f"\nMax index ever referenced: {max_idx_seen}")
