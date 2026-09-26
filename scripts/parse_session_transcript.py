#!/usr/bin/env python3
"""Parse a VS Code chatSession JSONL file into a readable transcript."""
import json, re, sys, os, glob

MIRROR_BASE = os.path.expanduser(
    "~/Library/Application Support/Code/User/globalStorage/"
    "aipieksel.codr-transcript/vscodehashes"
)

SKIP_KINDS = {
    "thinking", "toolInvocationSerialized", "mcpServersStarting",
    "undoStop", "codeblockUri", "progressTaskSerialized",
}

def extract_visible_text(parts):
    text = ""
    if not isinstance(parts, list):
        return text
    for part in parts:
        kind = part.get("kind") if isinstance(part, dict) else None
        if kind in SKIP_KINDS:
            continue
        if isinstance(part, dict):
            pv = part.get("value", "")
            if isinstance(pv, str) and pv.strip():
                text += pv
            elif isinstance(part.get("content"), dict):
                cv = part["content"].get("value", "")
                if isinstance(cv, str):
                    text += cv
        elif isinstance(part, str):
            text += part
    return text

def extract_user_text(req):
    """Extract user text — prefer message.text, fall back to parts."""
    msg = req.get("message") or {}
    # Direct text field (current VS Code format)
    txt = msg.get("text", "").strip()
    if txt:
        return txt
    # Legacy: renderedUserMessage with XML tags
    rendered = msg.get("renderedUserMessage", [])
    for part in (rendered or []):
        val = part.get("value", "")
        m = re.search(r'<userRequest>\s*(.*?)\s*</userRequest>', val, re.DOTALL)
        if m:
            return m.group(1).strip()
    for part in (rendered or []):
        val = part.get("value", "")
        for tag in ["</reminderInstructions>", "</context>"]:
            if tag in val:
                after = val.split(tag)[-1].strip()
                if after:
                    return after
    for part in (rendered or []):
        val = part.get("value", "")
        if val.strip():
            return val.strip()[:500]
    return ""

def parse_session(filepath):
    requests = {}   # requestId -> {user, assistant, done}
    idx_map = {}    # global index -> requestId

    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except Exception:
                continue
            if entry.get("kind") != 2:
                continue

            k = entry.get("k", [])
            v = entry.get("v")

            # Snapshot: k = ["requests"] — array of request objects
            if k == ["requests"] and isinstance(v, list):
                for req in v:
                    rid = req.get("requestId") or (req.get("message") or {}).get("requestId")
                    if not rid:
                        continue
                    if rid not in [x for x in idx_map.values()]:
                        # VS Code uses 1-based global indices for response updates
                        idx = len(idx_map) + 1
                        idx_map[idx] = rid
                    if rid not in requests:
                        requests[rid] = {"user": "", "assistant": "", "done": False}

                    user = extract_user_text(req)
                    if len(user) > len(requests[rid]["user"]):
                        requests[rid]["user"] = user

                    resp = req.get("response")
                    if isinstance(resp, list):
                        atxt = extract_visible_text(resp)
                    elif isinstance(resp, dict):
                        atxt = extract_visible_text(resp.get("value", []))
                    else:
                        atxt = ""
                    if len(atxt) > len(requests[rid]["assistant"]):
                        requests[rid]["assistant"] = atxt

                    if req.get("result") is not None:
                        requests[rid]["done"] = True

            # Response update: k = ["requests", N, "response"]
            # These are sequential segments, not cumulative — concatenate them
            elif len(k) == 3 and k[0] == "requests" and k[2] == "response":
                rid = idx_map.get(k[1])
                if not rid:
                    continue
                if rid not in requests:
                    requests[rid] = {"user": "", "assistant": "", "done": False}
                if isinstance(v, list):
                    atxt = extract_visible_text(v)
                elif isinstance(v, dict):
                    atxt = extract_visible_text(v.get("value", []))
                else:
                    atxt = ""
                if atxt:
                    requests[rid]["assistant"] += atxt

            # Result: k = ["requests", N, "result"]
            elif len(k) == 3 and k[0] == "requests" and k[2] == "result":
                rid = idx_map.get(k[1])
                if rid and rid in requests:
                    requests[rid]["done"] = True

    return requests

def main():
    # Find all session files across all workspace mirrors
    files = glob.glob(os.path.join(MIRROR_BASE, "*/chatSessions/*.jsonl"))
    if not files:
        print("No session files found in mirror.")
        sys.exit(1)
    files.sort(key=lambda f: os.path.getmtime(f), reverse=True)
    target = files[0]
    workspace = os.path.basename(os.path.dirname(os.path.dirname(target)))
    sid = os.path.basename(target).replace(".jsonl", "")

    print(f"Workspace: {workspace}")
    print(f"Session: {sid}")
    print(f"File: {target}")
    print(f"Size: {os.path.getsize(target) / 1024:.0f} KB")

    requests = parse_session(target)
    print(f"Turns: {len(requests)}")
    print("=" * 80)

    for i, (rid, data) in enumerate(requests.items(), 1):
        user = data["user"] or "(empty)"
        assistant = data["assistant"] or "(no response yet)"
        tag = "DONE" if data["done"] else "..."
        print(f"\n{'─' * 80}")
        print(f"  Turn {i} [{tag}]")
        print(f"{'─' * 80}")
        print(f"  YOU:  {user}\n")
        print(f"  BOT:  {assistant}\n")

if __name__ == "__main__":
    main()
