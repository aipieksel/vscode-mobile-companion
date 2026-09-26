#!/usr/bin/env python3
"""Debug: trace index mapping in session JSONL."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description="Trace request indexes in a user-supplied VS Code session JSONL.")
parser.add_argument("session", type=Path, help="Path to your local session export; do not commit the export")
SESSION = parser.parse_args().session.expanduser()

SKIP = {"thinking", "toolInvocationSerialized", "mcpServersStarting",
        "undoStop", "codeblockUri", "progressTaskSerialized"}

with open(SESSION) as f:
    lines = f.readlines()

print(f"Total lines: {len(lines)}")
idx_map = {}

for i, line in enumerate(lines):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except:
        continue
    if e.get("kind") != 2:
        continue
    k = e.get("k", [])
    v = e.get("v")

    if k == ["requests"] and isinstance(v, list):
        for req in v:
            rid = req.get("requestId", "?")
            if rid not in idx_map.values():
                idx = len(idx_map)
                idx_map[idx] = rid
            assigned = [ki for ki, vi in idx_map.items() if vi == rid][0]
            print(f"Line {i:3d}: SNAPSHOT  rid={rid[:30]}..  assigned_idx={assigned}")

    elif len(k) == 3 and k[0] == "requests" and k[2] == "response":
        idx = k[1]
        rid = idx_map.get(idx, "UNMAPPED")
        has_text = False
        if isinstance(v, list):
            for p in v:
                if not isinstance(p, dict):
                    continue
                pk = p.get("kind")
                if pk in SKIP:
                    continue
                pv = p.get("value", "")
                if isinstance(pv, str) and pv.strip():
                    has_text = True
                    break
        label = rid[:30] if rid != "UNMAPPED" else "UNMAPPED"
        print(f"Line {i:3d}: RESPONSE  idx={idx:2d} -> rid={label}..  has_visible={has_text}")

    elif len(k) == 3 and k[0] == "requests" and k[2] == "result":
        idx = k[1]
        rid = idx_map.get(idx, "UNMAPPED")
        label = rid[:30] if rid != "UNMAPPED" else "UNMAPPED"
        print(f"Line {i:3d}: RESULT    idx={idx:2d} -> rid={label}..")
