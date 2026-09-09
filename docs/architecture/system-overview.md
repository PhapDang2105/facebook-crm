# MVP Architecture

## Components

1. `web/`: single-page UI implemented with HTML, CSS, and JavaScript.
2. `app/server.mjs`: Node.js HTTP server, REST API, and atomic JSON persistence.
3. `app/domain.mjs`: pipeline, normalization, and segmentation rules used by both the API and tests.
4. `app/config.mjs`: `.env` loading plus Meta and server configuration shared by every module.
5. `app/channel-store.mjs`: connected Facebook Pages with AES-256-GCM encrypted Page access tokens.
6. `app/meta-graph.mjs`: Graph API client, Send API calls, and pure normalizers for Graph payloads.
7. `app/meta-webhook.mjs`: webhook signature checks and translation of Meta events into stored messages.
8. `app/meta-sync.mjs`: thread import from Graph and outbound sending.
9. `app/messaging-store.mjs`: conversation and message persistence with a serialized write queue.
10. `app/message-events.mjs`: in-process pub/sub feeding the Server-Sent Events stream.
11. `data/processed/crm-store.json`: runtime data created from the seed and excluded from Git.
12. `data/processed/meta-channels.json` and `meta-conversations.json`: connected Pages and the Messenger inbox, both excluded from Git.

## Available API

- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/leads?q=&status=`
- `POST /api/leads`
- `PATCH /api/leads/{id}`
- `GET /api/segments`
- `GET /api/channels`
- `GET /api/channels/meta/connect`, `GET /api/channels/meta/callback`, `GET /api/channels/meta/pending`, `POST /api/channels/meta/confirm`
- `POST /api/channels/facebook/{pageId}/refresh`, `DELETE /api/channels/facebook/{pageId}`
- `GET /webhooks/facebook`, `POST /webhooks/facebook`
- `GET /api/messaging/conversations?channelId=`
- `GET /api/messaging/conversations/{id}/messages`, `POST /api/messaging/conversations/{id}/messages`
- `POST /api/messaging/conversations/{id}/read`, `PATCH /api/messaging/conversations/{id}/flags`
- `POST /api/messaging/sync`
- `GET /api/messaging/stream` (Server-Sent Events)

## Messenger data flow

Meta webhook → signature check → `messaging-store` → SSE → browser inbox.
Reply in the browser → `POST /api/messaging/conversations/{id}/messages` → Send API → stored as outgoing → Meta echo confirms it.

Setup and operational details live in `integrations/meta/README.md`.

## Upgrade path

Replace the JSON persistence functions in `server.mjs` and `messaging-store.mjs` with a PostgreSQL repository, then add authentication/RBAC, audit logging, and queue workers. Domain logic remains independent from the UI and persistence mechanism.
