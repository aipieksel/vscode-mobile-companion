# Browser Client

This browser client reuses the legacy Codr VS design but talks directly to the merged desktop extension on `http://127.0.0.1:8767`.

## Run locally

Run from the repository root after starting the companion extension in VS Code.

```bash
npm run serve:browser
```

Then open:

- `http://127.0.0.1:4173`

## Current behavior

- reads extension health
- reads workspace info
- reads extension transcript
- sends prompts through `POST /chat`

The Mac helper is not involved.

## Offline interface check

From the repository root, run `node scripts/smoke-server.js` and open `http://127.0.0.1:18767`. It serves synthetic workspace/chat data and overrides only the served client’s discovery port. It never connects to your running extension or an AI provider. This verifies rendering and interaction, not real provider or mobile integration.

The retained Codr VS sidebar includes legacy presentation placeholders (SSE counts, token-auth status, push settings, browse/save/export/reset/log actions). Their presence does not establish working features. Current event handlers cover chat submission, provider selection, workspace discovery, sidebar navigation, and clearing the prompt. See `app.js` for the implemented surface.
