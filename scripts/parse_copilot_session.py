#!/usr/bin/env python3
"""Parse Copilot chat session JSONL files directly."""
import json
import os
from pathlib import Path

def parse_copilot_session(session_path):
    with open(session_path, 'r') as f:
        lines = f.read().strip().split('\n')
    
    requests_by_id = {}
    request_id_order = []
    
    for line in lines:
        try:
            entry = json.loads(line)
            
            # Build request snapshot
            if entry.get('kind') == 2 and entry.get('k') == ['requests'] and isinstance(entry.get('v'), list):
                request_id_order = []
                for req in entry['v']:
                    req_id = req.get('requestId')
                    if not req_id:
                        continue
                    request_id_order.append(req_id)
                    
                    user_text = req.get('message', {}).get('text', '')
                    response = req.get('response', [])
                    assistant_text = ''.join(
                        p.get('value', '') for p in response 
                        if isinstance(p, dict) and p.get('value') and not p.get('kind')
                    )
                    
                    requests_by_id[req_id] = {
                        'user': user_text,
                        'assistant': assistant_text,
                        'timestamp': req.get('timestamp', 0)
                    }
            
            # Incremental response updates
            k = entry.get('k', [])
            if entry.get('kind') == 2 and len(k) == 3 and k[0] == 'requests' and isinstance(k[1], int) and k[2] == 'response':
                idx = k[1]
                if idx < len(request_id_order):
                    req_id = request_id_order[idx]
                    response = entry.get('v', [])
                    assistant_text = ''.join(
                        p.get('value', '') for p in response 
                        if isinstance(p, dict) and p.get('value') and not p.get('kind')
                    )
                    if req_id in requests_by_id and len(assistant_text) > len(requests_by_id[req_id].get('assistant', '')):
                        requests_by_id[req_id]['assistant'] = assistant_text
        except:
            pass
    
    # Output messages sorted by timestamp
    messages = []
    for req_id, data in sorted(requests_by_id.items(), key=lambda x: x[1]['timestamp']):
        if data['user']:
            messages.append({'role': 'user', 'content': data['user'], 'timestamp': data['timestamp']})
        if data['assistant']:
            messages.append({'role': 'assistant', 'content': data['assistant'], 'timestamp': data['timestamp']})
    
    return messages

def find_workspace_session(workspace_name=None):
    """Find the most recent Copilot session for a workspace."""
    base_path = Path.home() / 'Library/Application Support/Code/User/workspaceStorage'
    
    # Find all workspace folders with chatSessions
    candidates = []
    for ws_dir in base_path.iterdir():
        chat_dir = ws_dir / 'chatSessions'
        ws_json = ws_dir / 'workspace.json'
        if chat_dir.exists() and ws_json.exists():
            try:
                ws_data = json.loads(ws_json.read_text())
                ws_path = ws_data.get('workspace', ws_data.get('folder', ''))
                sessions = list(chat_dir.glob('*.jsonl'))
                if sessions:
                    latest = max(sessions, key=lambda p: p.stat().st_mtime)
                    candidates.append({
                        'workspace': ws_path,
                        'session': latest,
                        'mtime': latest.stat().st_mtime
                    })
            except:
                pass
    
    if not candidates:
        return None
    
    # If workspace_name specified, filter
    if workspace_name:
        candidates = [c for c in candidates if workspace_name in c['workspace']]
    
    # Return most recently modified
    return max(candidates, key=lambda c: c['mtime'])

if __name__ == '__main__':
    import sys
    
    workspace = sys.argv[1] if len(sys.argv) > 1 else 'vscode-mobile'
    result = find_workspace_session(workspace)
    
    if not result:
        print("No session found")
        sys.exit(1)
    
    print(f"Workspace: {result['workspace']}")
    print(f"Session: {result['session'].name}")
    
    messages = parse_copilot_session(result['session'])
    print(f"Total: {len(messages)} messages")
    print("\nLast 10 messages:")
    for m in messages[-10:]:
        content = m['content'][:80].replace('\n', ' ')
        print(f"[{m['role']}] {content}")
