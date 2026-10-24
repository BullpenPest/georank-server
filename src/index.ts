import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  createGbpLocalPost,
  loadGbpConfig,
  uploadPhotoToGbp,
} from './gbp.js';
import {
  loadFacebookConfig,
  loadInstagramConfig,
  publishFacebookPhoto,
  publishInstagramPhoto,
} from './social.js';

/**
 * GeoRank Check-Ins backend stub.
 *
 * Endpoints:
 *   POST /api/checkins          record a verified on-site visit
 *   POST /api/media             multipart upload of a check-in photo/video
 *   POST /api/publish/gbp-photo publish a GPS-tagged photo to GBP (real when
 *                               GBP_* env vars are set, else stubbed)
 *   POST /api/publish/gbp-post  create a GBP local post (real when configured)
 *   POST /api/syndicate         cross-post to Facebook/Instagram (real when
 *                               FB_* and IG_* env vars are set, else stubbed)
 *
 * The /api/media route stores files under ./uploads and serves them at
 * /uploads/… so the mobile app's published URLs are reachable for GBP/Meta.
 * Swap the in-memory arrays for a real database before production use.
 */

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Log every request (method, path, status, duration) so Render's log tail
// shows app traffic — otherwise API calls are invisible in the logs.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

// In-memory stores (demo only).
const checkins: any[] = [];
const media: any[] = [];

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'georank-checkins-server', time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// POST /api/checkins
// ---------------------------------------------------------------------------
app.post('/api/checkins', (req, res) => {
  const body = req.body ?? {};
  const required = ['id', 'jobSiteId', 'checkedInAt', 'checkInLat', 'checkInLng', 'status'];
  const missing = required.filter((k) => body[k] == null);
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
  }
  const existing = checkins.findIndex((c) => c.id === body.id);
  if (existing >= 0) checkins[existing] = body;
  else checkins.push(body);
  return res.status(201).json({ id: body.id, received: true });
});

// ---------------------------------------------------------------------------
// POST /api/media  (multipart: file + checkInId + kind + latitude + …)
// ---------------------------------------------------------------------------
app.post('/api/media', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file attached (field name "file").' });
  const safeName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, safeName), req.file.buffer);
  const record = {
    fileName: safeName,
    url: `/uploads/${safeName}`,
    checkInId: req.body.checkInId ?? null,
    kind: req.body.kind ?? 'photo',
    latitude: req.body.latitude || null,
    longitude: req.body.longitude || null,
    capturedAt: req.body.capturedAt ?? new Date().toISOString(),
    sizeBytes: req.file.size,
    mimeType: req.file.mimetype,
  };
  media.push(record);
  // NOTE: this URL is relative — the mobile app prefixes it with the API base
  // URL to build an absolute URL for GBP/Meta. For Meta/FB the URL must be
  // publicly reachable (use a tunnel or public host, not localhost).
  return res.status(201).json({ url: record.url, fileName: safeName });
});

// ---------------------------------------------------------------------------
// POST /api/publish/gbp-photo
// ---------------------------------------------------------------------------
app.post('/api/publish/gbp-photo', async (req, res) => {
  const { imageUrl, caption, latitude, longitude, accountId, locationId } = req.body ?? {};
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required.' });

  const cfg = loadGbpConfig();
  if (!cfg) {
    return res.json({
      ok: true,
      stub: true,
      message:
        'GBP credentials not configured — returning a stubbed success. Set GBP_CLIENT_ID / GBP_CLIENT_SECRET / GBP_REFRESH_TOKEN / GBP_ACCOUNT_ID / GBP_LOCATION_ID to publish for real.',
      echo: { caption, latitude, longitude, accountId, locationId },
    });
  }

  try {
    const absoluteUrl = toAbsoluteUrl(imageUrl);
    const imgRes = await fetch(absoluteUrl);
    if (!imgRes.ok) throw new Error(`Could not download image (${imgRes.status}).`);
    const bytes = Buffer.from(await imgRes.arrayBuffer());
    const result = await uploadPhotoToGbp(
      cfg,
      { bytes, mimeType: 'image/jpeg' },
      caption ?? 'Job-site photo',
    );
    return res.json({ ok: true, id: result.name, url: result.googleUrl });
  } catch (e: any) {
    return res.status(502).json({ error: e?.message ?? 'GBP photo publish failed.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/publish/gbp-post
// ---------------------------------------------------------------------------
app.post('/api/publish/gbp-post', async (req, res) => {
  const { summary, imageUrl, callToActionUrl } = req.body ?? {};
  if (!summary) return res.status(400).json({ error: 'summary is required.' });

  const cfg = loadGbpConfig();
  if (!cfg) {
    return res.json({
      ok: true,
      stub: true,
      message:
        'GBP credentials not configured — returning a stubbed success. Set the GBP_* env vars to publish for real.',
      echo: { summary: summary.slice(0, 120) },
    });
  }

  try {
    const result = await createGbpLocalPost(cfg, {
      summary,
      imageUrl: imageUrl ? toAbsoluteUrl(imageUrl) : undefined,
      actionUrl: callToActionUrl,
    });
    return res.json({ ok: true, id: result.name });
  } catch (e: any) {
    return res.status(502).json({ error: e?.message ?? 'GBP post publish failed.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/syndicate  → Facebook Page photo + Instagram photo
// ---------------------------------------------------------------------------
app.post('/api/syndicate', async (req, res) => {
  const { imageUrl, caption } = req.body ?? {};
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required.' });
  const absoluteUrl = toAbsoluteUrl(imageUrl);

  const fbCfg = loadFacebookConfig();
  const igCfg = loadInstagramConfig();
  if (!fbCfg && !igCfg) {
    return res.json({
      ok: true,
      stub: true,
      message:
        'Meta credentials not configured — returning a stubbed success. Set FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN / IG_USER_ID / IG_ACCESS_TOKEN to syndicate for real.',
    });
  }

  const results: Record<string, unknown> = {};
  try {
    if (fbCfg) results.facebook = await publishFacebookPhoto(fbCfg, { imageUrl: absoluteUrl, caption: caption ?? '' });
    if (igCfg) results.instagram = await publishInstagramPhoto(igCfg, { imageUrl: absoluteUrl, caption: caption ?? '' });
    return res.json({ ok: true, ...results });
  } catch (e: any) {
    return res.status(502).json({ error: e?.message ?? 'Syndication failed.', ...results });
  }
});

/** Resolve a relative /uploads/… URL against this server's public base. */
function toAbsoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
  return `${base.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

app.listen(PORT, () => {
  console.log(`GeoRank Check-Ins server listening on http://localhost:${PORT}`);
  if (!loadGbpConfig()) console.log('• GBP publishing: STUB mode (set GBP_* env vars for real publishing)');
  if (!loadFacebookConfig() && !loadInstagramConfig())
    console.log('• Social syndication: STUB mode (set FB_*/IG_* env vars for real publishing)');
});
