# Gateway Service Server

The gateway's non-public service surfaces live in this role. They are exported
from the same deployed `ragbot-worker` script as WorkerEntrypoints and Durable
Objects because those Cloudflare bindings are part of the gateway application.

- `ApplicationMiddleware` prepares signed `application.request` messages for
  generated application middleware clients.
- `DevProxy` receives the production dev-proxy service-binding command path.
