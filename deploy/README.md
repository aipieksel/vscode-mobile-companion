# Deployment configuration example

`nginx.example.conf` shows the HTTP/WebSocket proxy shape with reserved example domains and a loopback relay. Replace values only with infrastructure you control. The old machine-specific server provisioner is not distributed; this example makes no firewall, SSH, certificate, or service changes.

The current relay uses development identity fallbacks and in-memory state. Implement and verify the required authentication, TLS, origin/access boundaries, and persistence before exposing it to the internet. A reverse proxy alone does not supply these application guarantees. Local build/use is documented in the [root README](../README.md).
