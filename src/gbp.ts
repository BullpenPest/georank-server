import { google } from 'googleapis';

/**
 * Google Business Profile publishing.
 *
 * Real code paths — NOT mocks. Media upload and local-post creation follow
 * the documented GBP REST shapes (mybusiness v4 media + localPosts), while
 * OAuth2 is handled through the official `googleapis` client.
 *
 * WHAT YOU NEED FOR THESE TO REALLY PUBLISH (see server/README.md):
 *  1. A Google Cloud project with the "Google Business Profile" APIs enabled.
 *  2. OAuth2 consent screen + Web-application client (client ID/secret).
 *  3. A one-time OAuth grant for the `business.manage` scope → refresh token.
 *  4. The GBP location must be owned/verified by that Google account, and your
 *     use case may need Google's Business Profile API access approval.
 * Without the env vars below, the Express routes return clearly-marked stub
 * responses instead of calling Google.
 */

export const GBP_SCOPES = ['https://www.googleapis.com/auth/business.manage'];

export interface GbpConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId: string;
  locationId: string;
}

export function loadGbpConfig(): GbpConfig | null {
  const { GBP_CLIENT_ID, GBP_CLIENT_SECRET, GBP_REFRESH_TOKEN, GBP_ACCOUNT_ID, GBP_LOCATION_ID } =
    process.env;
  if (!GBP_CLIENT_ID || !GBP_CLIENT_SECRET || !GBP_REFRESH_TOKEN || !GBP_ACCOUNT_ID || !GBP_LOCATION_ID) {
    return null;
  }
  return {
    clientId: GBP_CLIENT_ID,
    clientSecret: GBP_CLIENT_SECRET,
    refreshToken: GBP_REFRESH_TOKEN,
    accountId: GBP_ACCOUNT_ID,
    locationId: GBP_LOCATION_ID,
  };
}

/** `accounts/{accountId}/locations/{locationId}` resource name. */
export function locationName(cfg: Pick<GbpConfig, 'accountId' | 'locationId'>): string {
  return `accounts/${cfg.accountId}/locations/${cfg.locationId}`;
}

function oauthClient(cfg: GbpConfig) {
  const client = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
  client.setCredentials({ refresh_token: cfg.refreshToken });
  return client;
}

async function accessToken(cfg: GbpConfig): Promise<string> {
  const { token } = await oauthClient(cfg).getAccessToken();
  if (!token) throw new Error('Could not mint a Google access token — check GBP_CLIENT_ID/SECRET/REFRESH_TOKEN.');
  return token;
}

async function gbpFetch(
  cfg: GbpConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<any> {
  const token = await accessToken(cfg);
  const res = await fetch(`https://mybusiness.googleapis.com/v4/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: init.body != null ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`GBP API error (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export interface GbpPhotoResult {
  name: string; // e.g. accounts/…/locations/…/media/…
  googleUrl?: string;
}

/**
 * Publish a photo to the GBP listing. Three-step flow per the GBP media docs:
 *  1. media:startUpload → { resourceName }
 *  2. PUT the raw bytes to /upload/v1/media/{resourceName}?upload_type=media
 *  3. media.create with dataRef: { resourceName } from step 1
 */
export async function uploadPhotoToGbp(
  cfg: GbpConfig,
  image: { bytes: Buffer; mimeType: string },
  caption: string,
): Promise<GbpPhotoResult> {
  const parent = locationName(cfg);

  const started = await gbpFetch(cfg, `${parent}/media:startUpload`, { method: 'POST' });
  // Per the documented flow, startUpload returns a MediaItemDataRef:
  //   { "resourceName": "<GoogleProvidedValue>" }
  // Raw bytes then go to the /upload/v1 endpoint keyed by that resourceName,
  // and the SAME resourceName is passed as dataRef in media.create below.
  const resourceName: string | undefined = started?.resourceName;
  if (!resourceName) throw new Error('GBP did not return a resourceName from media:startUpload.');

  // Per Google's documented upload flow, the byte upload is a POST (not a
  // PUT) to /upload/v1/media/{resourceName}?upload_type=media, and it must
  // carry the OAuth access token. A PUT here is not routed by Google and
  // returns 404.
  const token = await accessToken(cfg);
  const put = await fetch(
    `https://mybusiness.googleapis.com/upload/v1/media/${resourceName}?upload_type=media`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': image.mimeType,
      },
      body: new Uint8Array(image.bytes),
    },
  );
  if (!put.ok) {
    const detail = await put.text().catch(() => '');
    throw new Error(`GBP byte upload failed (HTTP ${put.status}): ${detail.slice(0, 500)}`);
  }

  const created = await gbpFetch(cfg, `${parent}/media`, {
    method: 'POST',
    body: {
      mediaFormat: 'PHOTO',
      locationAssociation: { category: 'ADDITIONAL' },
      description: caption.slice(0, 1000),
      dataRef: { resourceName },
    },
  });
  return { name: created.name, googleUrl: created.googleUrl };
}

export interface GbpLocalPostResult {
  name: string; // e.g. accounts/…/locations/…/localPosts/…
}

/**
 * Create a GBP local post (the "What's new / update" card on the listing).
 * Shape: POST v4/{location}/localPosts
 *   { languageCode, summary, topicType: 'STANDARD',
 *     callToAction: { actionType: 'LEARN_MORE', url },
 *     media: [{ mediaFormat: 'PHOTO', sourceUrl }] }
 */
export async function createGbpLocalPost(
  cfg: GbpConfig,
  input: { summary: string; imageUrl?: string; actionUrl?: string },
): Promise<GbpLocalPostResult> {
  const parent = locationName(cfg);
  const created = await gbpFetch(cfg, `${parent}/localPosts`, {
    method: 'POST',
    body: {
      languageCode: 'en-US',
      summary: input.summary.slice(0, 1500),
      topicType: 'STANDARD',
      callToAction: input.actionUrl
        ? { actionType: 'LEARN_MORE', url: input.actionUrl }
        : undefined,
      media: input.imageUrl ? [{ mediaFormat: 'PHOTO', sourceUrl: input.imageUrl }] : [],
    },
  });
  return { name: created.name };
}
