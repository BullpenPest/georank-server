# GeoRank Check-Ins — Backend Stub

Express API that receives verified check-ins + media from the mobile app and
publishes GPS-tagged photos and local posts to Google Business Profile (GBP)
and Meta (Facebook/Instagram).

## Quick start

```bash
cd server
npm install
cp .env.example .env   # then fill in credentials (below)
npm run dev            # ts-node, http://localhost:4000
```

The mobile app's **Settings → API base URL** must point here
(default `http://localhost:4000`; on a physical device use your machine's LAN IP,
e.g. `http://192.168.1.20:4000`).

`npm run build && npm start` compiles to `dist/` and runs the JS.

## Endpoints

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/health` | — | Liveness probe |
| POST | `/api/checkins` | Check-in JSON (id, jobSiteId, checkedInAt, checkInLat/Lng, status…) | Stored in memory (demo) |
| POST | `/api/media` | `multipart/form-data`: `file` + `checkInId`, `kind`, `latitude`, `longitude`, `capturedAt` | Saved to `./uploads/`, served at `/uploads/…` |
| POST | `/api/publish/gbp-photo` | `{ imageUrl, caption, latitude, longitude, accountId, locationId }` | Real when GBP env is set, else `{ ok: true, stub: true }` |
| POST | `/api/publish/gbp-post` | `{ summary, imageUrl?, callToActionUrl? }` | Real when GBP env is set, else stubbed |
| POST | `/api/syndicate` | `{ imageUrl, caption }` | Real when FB/IG env is set, else stubbed |

## Environment variables

Copy `.env.example` to `.env`. All publishing credentials are optional —
without them the publish routes return clearly-marked stub successes so the
mobile demo works end-to-end.

## Google Business Profile setup (for REAL publishing)

The code in `src/gbp.ts` uses the official `googleapis` OAuth2 client and the
documented GBP REST shapes (`v4/{location}/media:startUpload` →
byte upload → `media.create`; `v4/{location}/localPosts` create).

1. **Google Cloud project** — create one at console.cloud.google.com.
2. **Enable APIs** — "Google Business Profile" APIs
   (Business Information / Account Management as needed).
3. **API access approval** — Google requires approval for Business Profile API
   access for most use cases. Apply via the Google Business Profile API access
   request form and wait for approval before production use.
4. **OAuth consent screen** — configure (External or Internal), add scope
   `https://www.googleapis.com/auth/business.manage`.
5. **OAuth client ID** — create a *Web application* client → `GBP_CLIENT_ID`,
   `GBP_CLIENT_SECRET`.
6. **Refresh token** — run the OAuth consent flow once for the Google account
   that owns/manages the GBP location (e.g. via the OAuth2 playground or a
   small script) and store the refresh token as `GBP_REFRESH_TOKEN`.
7. **IDs** — the numeric GBP account + location IDs → `GBP_ACCOUNT_ID`,
   `GBP_LOCATION_ID` (also editable in the app's Settings screen).

⚠️ Only publish media for locations you own/manage and visits that really
happened. Fabricated location signals violate Google's policies.

## Facebook / Instagram setup (for REAL syndication)

`src/social.ts` implements the real Meta Graph API shapes (`v21.0`).

1. Create a Meta app at developers.facebook.com; add the business's Facebook Page.
2. Page access token with `pages_manage_posts` (+ `pages_read_engagement`):
   `FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN`.
3. Convert the Instagram account to a **professional** account and link it to
   the Page → `IG_USER_ID`, `IG_ACCESS_TOKEN` (often the same page token).
4. Media URLs must be **publicly reachable** by Meta — localhost won't work.
   Set `PUBLIC_BASE_URL` (e.g. an ngrok/tunnel URL or your public host) so
   `/uploads/…` URLs resolve externally.

## Production notes

- Replace the in-memory `checkins`/`media` arrays with a real database.
- Serve `/uploads` from object storage (S3/GCS) with signed or public URLs.
- Put this API behind HTTPS + auth (API keys or user tokens); never expose
  the OAuth refresh token to the mobile client.
