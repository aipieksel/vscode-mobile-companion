# Architecture and development boundaries

The [VS Code extension](../project/extension/vscode-mobile-companion/src/) talks to the [relay](../project/services/relay-backend/src/server.ts) using the shared protocol in each component. The relay maintains pairing codes, devices and sessions in process memory. The [browser](../project/browser/) is a separate static client that calls the extension HTTP API on loopback ports 8767–8772, independently of the relay.

Desktop provider execution depends on the host VS Code session. The relay is a development prototype: its fallback identity is not a deployment-grade account boundary, and a restart loses in-memory state. Build the Node components with the root workspace scripts.

Preserve existing command/configuration IDs when changing display names so user settings remain compatible. Never include real pairing codes, transcript exports, machine paths, or account cookies in examples.
