# MVP Architecture

## Components

1. `web/`: single-page UI implemented with HTML, CSS, and JavaScript.
2. `app/server.mjs`: Node.js HTTP server, REST API, and atomic JSON persistence.
3. `app/domain.mjs`: pipeline, normalization, and segmentation rules used by both the API and tests.
4. `data/processed/crm-store.json`: runtime data created from the seed and excluded from Git.

## Available API

- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/leads?q=&status=`
- `POST /api/leads`
- `PATCH /api/leads/{id}`
- `GET /api/segments`

## Upgrade path

Replace the JSON persistence functions in `server.mjs` with a PostgreSQL repository, then add authentication/RBAC, Meta webhooks, audit logging, and queue workers. Domain logic remains independent from the UI and persistence mechanism.
