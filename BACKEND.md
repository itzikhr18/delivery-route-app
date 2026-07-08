# Backend API beta foundation

Version 3.7.0 adds an optional backend layer for a paid beta path. The app still works as a static GitHub Pages PWA when `config.js` has an empty `apiBaseUrl`.

## Local frontend only

```bash
npm.cmd start
```

Open:

```text
http://127.0.0.1:8000
```

## Local API server

```bash
copy .env.example .env
npm.cmd run api
```

Open:

```text
http://127.0.0.1:8787/api/health
```

Then set `apiBaseUrl` in `config.js`:

```js
apiBaseUrl: 'http://127.0.0.1:8787'
```

## API endpoints

- `GET /api/health`
- `GET /api/usage`
- `POST /api/geocode`
- `POST /api/optimize-route`

## Commercial beta setup

For a commercial beta, set `GEOAPIFY_API_KEY` in `.env` and keep the key only on the backend.

The backend includes:

- Address cache in `.cache/geocode-cache.json`
- Per-IP rate limiting
- Route stop limits
- Geoapify support for geocoding and route planning
- Public Nominatim/OSRM fallback for local testing when no Geoapify key exists

For production, set:

```text
ALLOWED_ORIGINS=https://itzikhr18.github.io
ROUTE_STOP_LIMIT=60
RATE_LIMIT_PER_MINUTE=60
```

In a paid product, also set `directFallback: false` in `config.js` so users cannot bypass the backend quota controls.
