#!/usr/bin/env python3
"""Inspect the response format in the active VS Code chat session file."""
import json, os, glob

base = os.path.expanduser(
    "~/Library/Application Support/Code/User/workspaceStorage/"
    "cf55ca1d171f6da737f5247bca9469a9/chatSessions"
)
files = sorted(glob.glob(os.path.join(base, "*.jsonl")), key=os.path.getmtime, reverse=True)
if not files:
    print("No session files found")
    exit(1)

session_path = files[0]
print(f"Reading: {os.path.basename(session_path)}")

with open(session_path) as f:
    lines = [json.loads(l) for l in f if l.strip()]

# Find last requests snapshot
for line in reversed(lines):
    if line.get("kind") == 2 and line.get("k") == ["requests"]:
        reqs = line["v"]
        print(f"Total requests: {len(reqs)}")

        # Categorize response formats
        no_resp = 0
        kind_only = 0
        plain_only = 0
        mixed = 0
        for req in reqs:
            resp = req.get("response", [])
            if not resp:
                no_resp += 1
                continue
            has_kind = any(p.get("kind") for p in resp)
            has_plain = any(p.get("value") and not p.get("kind") for p in resp)
            if has_kind and has_plain:
                mixed += 1
            elif has_kind:
                kind_only += 1
            elif has_plain:
                plain_only += 1
            else:
                no_resp += 1

        print(f"  no_response: {no_resp}")
        print(f"  plain_value (no kind): {plain_only}")
        print(f"  kind_only: {kind_only}")
        print(f"  mixed: {mixed}")

        # Show example of kind-only response
        for req in reqs:
            resp = req.get("response", [])
            has_kind = any(p.get("kind") for p in resp)
            has_plain = any(p.get("value") and not p.get("kind") for p in resp)
            if has_kind and not has_plain and resp:
                print(f"\nExample kind-only response:")
                for i, part in enumerate(resp[:5]):
                    print(f"  Part {i}:")
                    print(f"    keys: {list(part.keys())}")
                    print(f"    kind: {part.get('kind')}")
                    if "content" in part:
                        c = part["content"]
                        if isinstance(c, dict):
                            print(f"    content keys: {list(c.keys())}")
                            if "value" in c:
                                print(f"    content.value: {repr(c['value'][:150])}")
                        else:
                            print(f"    content: {repr(str(c)[:100])}")
                    if "value" in part:
                        print(f"    value: {repr(str(part['value'])[:150])}")
                break

        # Count all distinct kind values
        all_kinds = set()
        for req in reqs:
            for p in req.get("response", []):
                if p.get("kind"):
                    all_kinds.add(p["kind"])
        print(f"\nAll response part kinds: {sorted(all_kinds)}")
        break
