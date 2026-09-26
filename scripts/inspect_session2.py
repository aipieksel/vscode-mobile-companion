#!/usr/bin/env python3
"""Deeper inspection of the VS Code chat session JSONL file."""
import json, os, glob

base = os.path.expanduser(
    "~/Library/Application Support/Code/User/workspaceStorage/"
    "cf55ca1d171f6da737f5247bca9469a9/chatSessions"
)
files = sorted(glob.glob(os.path.join(base, "*.jsonl")), key=os.path.getmtime, reverse=True)
session_path = files[0]
print(f"File: {os.path.basename(session_path)}")
print(f"Size: {os.path.getsize(session_path)} bytes")

with open(session_path) as f:
    lines = [json.loads(l) for l in f if l.strip()]

print(f"Total JSONL lines: {len(lines)}")

# Count entry types
from collections import Counter
kind_counts = Counter()
key_patterns = Counter()
for line in lines:
    kind_counts[line.get("kind")] += 1
    k = line.get("k", [])
    key_patterns["/".join(str(x) for x in k)] += 1

print(f"\nEntry kinds: {dict(kind_counts)}")
print(f"Key patterns (top 20):")
for pattern, count in key_patterns.most_common(20):
    print(f"  {pattern}: {count}")

# Count request snapshots (kind=2, k=['requests'])
req_snapshots = []
for line in lines:
    if line.get("kind") == 2 and line.get("k") == ["requests"]:
        req_snapshots.append(len(line.get("v", [])))

print(f"\nRequest snapshots: {len(req_snapshots)}")
if req_snapshots:
    print(f"  Request counts per snapshot: {req_snapshots[-5:]}")

# Check incremental response updates
inc_responses = 0
for line in lines:
    k = line.get("k", [])
    if len(k) >= 3 and k[0] == "requests" and k[2] == "response":
        inc_responses += 1
print(f"Incremental response updates: {inc_responses}")

# Check ALL request snapshots for response content
print("\n--- Analyzing ALL request snapshots ---")
for snap_idx, line in enumerate(lines):
    if line.get("kind") == 2 and line.get("k") == ["requests"]:
        reqs = line["v"]
        for ri, req in enumerate(reqs):
            resp = req.get("response", [])
            if not resp:
                continue
            kinds_in_resp = set()
            total_text = 0
            for p in resp:
                if p.get("kind"):
                    kinds_in_resp.add(p["kind"])
                # Count text from various locations
                if isinstance(p.get("value"), str):
                    total_text += len(p["value"])
                if isinstance(p.get("content"), dict) and isinstance(p["content"].get("value"), str):
                    total_text += len(p["content"]["value"])
            user_text = req.get("message", {}).get("text", "")[:60]
            print(f"  Snap {snap_idx}, Req {ri}: kinds={sorted(kinds_in_resp)}, text_chars={total_text}, user='{user_text}'")

# Also look at chatEditingSessions
edit_base = os.path.expanduser(
    "~/Library/Application Support/Code/User/workspaceStorage/"
    "cf55ca1d171f6da737f5247bca9469a9/chatEditingSessions"
)
if os.path.exists(edit_base):
    edit_dirs = os.listdir(edit_base)
    print(f"\nchatEditingSessions dirs: {len(edit_dirs)}")
    for d in sorted(edit_dirs, key=lambda x: os.path.getmtime(os.path.join(edit_base, x)), reverse=True)[:3]:
        state_file = os.path.join(edit_base, d, "state.json")
        if os.path.exists(state_file):
            sz = os.path.getsize(state_file)
            import time
            mtime = time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(state_file)))
            print(f"  {d}: {sz} bytes, modified {mtime}")
            with open(state_file) as f:
                state = json.load(f)
            # Check for requests
            tl = state.get("timeline", {})
            entries = tl.get("entries", [])
            snap = state.get("recentSnapshot", {})
            snap_reqs = snap.get("requests", [])
            print(f"    timeline entries: {len(entries)}, snapshot requests: {len(snap_reqs)}")
            if snap_reqs:
                for si, sr in enumerate(snap_reqs[-3:]):
                    resp = sr.get("response", [])
                    kinds_in = set(p.get("kind","") for p in resp if p.get("kind"))
                    txt = sum(len(p.get("value","")) for p in resp if isinstance(p.get("value"),str))
                    txt += sum(len(p.get("content",{}).get("value","")) for p in resp if isinstance(p.get("content"),dict))
                    user = sr.get("message",{}).get("text","")[:60]
                    print(f"      Req {si}: kinds={sorted(kinds_in)}, text={txt}, user='{user}'")
