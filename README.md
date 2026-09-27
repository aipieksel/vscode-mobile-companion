# VS Code Mobile Companion

Maintained by [aipieksel](https://github.com/aipieksel).

VS Code Mobile Companion explores how a browser could follow and interact with a VS Code session away from the desktop editor. The package includes a VS Code extension for pairing and chat commands, a Node/WebSocket relay for session updates, and a separate browser interface.

This is a development prototype. The current browser interface calls the extension's local HTTP API, so opening it on a phone does not yet connect that phone through the relay. Pairing and provider behavior also depend on the desktop VS Code session. The component guides below show what can be run locally and where the cross-device boundary remains.

## How the pieces fit

1. The desktop extension exposes commands and the local companion API.
2. The relay holds pairing and session state in memory for development.
3. The browser client presents the companion UI and currently searches loopback for the extension API.

## Components

| Folder | Role and current state |
| --- | --- |
| `project/extension/vscode-mobile-companion` | VS Code extension, desktop pairing and provider integration |
| `project/services/relay-backend` | Node/WebSocket relay with in-memory sessions |
| `project/browser` | Browser companion interface |

The root npm build covers the extension and relay. The browser client is served separately.

## Build and try locally

Use Node.js 20+ and npm; Python 3 serves the browser client.

```sh
npm ci
npm run build
# In one terminal:
node project/services/relay-backend/dist/server.js
# In a second terminal:
npm run serve:browser
```

Open `http://localhost:4173` on the computer running the extension. The browser scans extension API ports 8767–8772 on loopback; it does not use the relay’s `/v1/` protocol. A phone’s loopback address is its own device, so this browser build is not a working cross-device relay client. The relay defaults to port 8787; set `PORT` and `PUBLIC_BASE_URL` in the process environment to override it. [.env.example](.env.example) documents the supported variables; the relay does not automatically load that file. `npm run dev:backend` watches TypeScript compilation and does not start the server.

Open the extension folder in VS Code and use an Extension Development Host. Commands retain the existing **Codr Companion** prefix and `codrCompanion.*` configuration IDs for compatibility. Configure the relay URL, connect, and start pairing. Provider availability depends on the desktop VS Code/Copilot session.

## Limitations and privacy

The relay's fallback local user identity and in-memory state are development scaffolding. This is not a production authentication or durable-storage implementation. No mobile Store or Marketplace release is included.

Private chat transcripts, pairing/session state, logs, local workspace settings, and copied conversation mockups are excluded. Supply your own workspace and session during use. Review the [architecture](docs/architecture.md) and component READMEs before development.

Owner-original source is [MIT](LICENSE). Fonts remain under the SIL Open Font License in `project/browser/fonts/OFL.txt`.
