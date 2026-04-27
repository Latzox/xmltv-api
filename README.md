# xmltv-api

A lightweight REST API that wraps an XMLTV `guide.xml` file and exposes it as clean JSON endpoints — designed to be consumed by AI agents (e.g. via n8n).

It fetches the guide from the [iptv-org/epg](https://github.com/iptv-org/epg) container over HTTP, parses it in memory, and refreshes it periodically.

---

## Stack

- **Node.js** + **Express** — API server
- **fast-xml-parser** — XMLTV parsing
- **axios** — HTTP fetching
- **Docker** + **Docker Compose** — deployment

---

## Project Structure

```
epg-api/
├── server.js          # Express app
├── package.json
├── Dockerfile
└── docker-compose.yml # Runs both epg + epg-api together
```

---

## Deployment

Place `docker-compose.yml` alongside your `channels.xml` file and the `epg-api/` folder:

```
/home/latzo/epg/
├── channels.xml
├── docker-compose.yml
└── epg-api/
    ├── server.js
    ├── package.json
    └── Dockerfile
```

Then start both containers:

```bash
docker compose up -d
```

The `epg-api` container will fetch `guide.xml` from the `epg` container on startup via `http://epg:3000/guide.xml` and refresh it every hour.

---

## Environment Variables

| Variable              | Default                     | Description                          |
| --------------------- | --------------------------- | ------------------------------------ |
| `EPG_URL`             | `http://epg:3000/guide.xml` | URL to fetch the XMLTV guide from    |
| `REFRESH_INTERVAL_MS` | `3600000`                   | How often to re-fetch the guide (ms) |
| `PORT`                | `3001`                      | Port the API listens on              |

---

## Endpoints

### `GET /health`

Returns the current status of the API.

```json
{
  "status": "ok",
  "lastFetched": "2026-04-27T11:38:00.000Z",
  "channels": 2060,
  "programmes": 48320
}
```

---

### `GET /channels`

Returns all channels. Optionally filter by name or ID.

**Query params:**

- `q` — search term (matches channel name or ID)

```
GET /channels?q=srf
```

```json
{
  "count": 3,
  "channels": [
    { "id": "SRF1.ch", "name": "SRF 1", "icon": "https://..." },
    { "id": "SRF2.ch", "name": "SRF 2", "icon": "https://..." },
    { "id": "SRFinfo.ch", "name": "SRF info", "icon": null }
  ]
}
```

---

### `GET /now`

Returns what is currently airing on all channels.

**Query params:**

- `channel` — filter by channel name or ID (partial match)

```
GET /now
GET /now?channel=srf
```

```json
{
  "time": "2026-04-27T14:22:00.000Z",
  "count": 2,
  "programmes": [
    {
      "channel": "SRF 1",
      "channelId": "SRF1.ch",
      "title": "Tagesschau",
      "description": "Die aktuellen Nachrichten.",
      "category": "News",
      "start": "2026-04-27T14:00:00.000Z",
      "stop": "2026-04-27T14:20:00.000Z",
      "minutesRemaining": 8
    }
  ]
}
```

---

### `GET /next`

Returns upcoming programmes within the next N hours.

**Query params:**

- `hours` — look-ahead window (default: `2`, max: `24`)
- `channel` — filter by channel name or ID (partial match)

```
GET /next?hours=3&channel=srf
```

```json
{
  "time": "2026-04-27T14:22:00.000Z",
  "hours": 3,
  "count": 5,
  "programmes": [
    {
      "channel": "SRF 1",
      "channelId": "SRF1.ch",
      "title": "Meteo",
      "description": null,
      "category": "Weather",
      "start": "2026-04-27T14:55:00.000Z",
      "stop": "2026-04-27T15:00:00.000Z",
      "startsInMinutes": 33
    }
  ]
}
```

---

### `GET /channel/:id`

Returns the full schedule for a specific channel for today or a given date.

**URL params:**

- `:id` — channel ID (e.g. `SRF1.ch`) or channel name (case-insensitive)

**Query params:**

- `date` — `YYYY-MM-DD` or `today` (default: today)

```
GET /channel/SRF1.ch
GET /channel/SRF1.ch?date=2026-04-28
```

```json
{
  "channel": "SRF 1",
  "channelId": "SRF1.ch",
  "date": "2026-04-27",
  "count": 24,
  "programmes": [
    {
      "title": "Tagesschau",
      "description": "Die aktuellen Nachrichten.",
      "category": "News",
      "start": "2026-04-27T14:00:00.000Z",
      "stop": "2026-04-27T14:20:00.000Z",
      "episode": null,
      "rating": null
    }
  ]
}
```

---

### `GET /search`

Search for upcoming programmes by title, description, or category. Returns a maximum of 100 results.

**Query params:**

- `q` — search term (matches title or description)
- `category` — filter by category
- `date` — `YYYY-MM-DD` to restrict to a specific day

At least one of `q` or `category` is required.

```
GET /search?q=news
GET /search?category=sport&date=2026-04-28
GET /search?q=football&category=sport
```

```json
{
  "query": "football",
  "category": "sport",
  "count": 4,
  "programmes": [
    {
      "channel": "SRF 2",
      "channelId": "SRF2.ch",
      "title": "Super League: FC Basel - YB",
      "description": "Live football from Switzerland.",
      "category": "Sport",
      "start": "2026-04-28T19:00:00.000Z",
      "stop": "2026-04-28T21:00:00.000Z"
    }
  ]
}
```

---

### `POST /refresh`

Forces an immediate re-fetch and re-parse of the guide.

```
POST /refresh
```

```json
{
  "status": "ok",
  "lastFetched": "2026-04-27T14:30:00.000Z"
}
```

---

## Using with n8n

In n8n, add an **HTTP Request** node with:

- **Method:** GET
- **URL:** `http://<your-server>:3001/now`

Feed the JSON response directly into your AI agent node. Useful prompts to pair with the data:

- *"What's on TV right now?"* → `/now`
- *"Is there anything about football on tonight?"* → `/search?category=sport&date=today`
- *"What's on SRF 1 today?"* → `/channel/SRF1.ch`
- *"What's coming up in the next 2 hours?"* → `/next?hours=2`