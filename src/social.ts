/**
 * Facebook + Instagram syndication via the Meta Graph API.
 *
 * Real endpoint shapes — NOT mocks. Each function performs the actual
 * Graph API calls when credentials are present. The Express route falls back
 * to a clearly-marked stub response when env vars are missing (see
 * server/README.md for how to obtain tokens).
 *
 * Facebook photo post:
 *   POST https://graph.facebook.com/{v}/{page-id}/photos
 *     { url, caption, access_token }
 *
 * Instagram photo post (two steps, professional account required):
 *   1. POST https://graph.facebook.com/{v}/{ig-user-id}/media
 *        { image_url, caption, access_token } → { id: creation_id }
 *   2. POST https://graph.facebook.com/{v}/{ig-user-id}/media_publish
 *        { creation_id, access_token } → { id: media_id }
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function graphPost(path: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Graph API error (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export interface FbConfig {
  pageId: string;
  pageAccessToken: string;
}

export function loadFacebookConfig(): FbConfig | null {
  const { FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN } = process.env;
  if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) return null;
  return { pageId: FB_PAGE_ID, pageAccessToken: FB_PAGE_ACCESS_TOKEN };
}

/** Publish a photo to the Facebook Page's feed. */
export async function publishFacebookPhoto(
  cfg: FbConfig,
  input: { imageUrl: string; caption: string },
): Promise<{ id: string }> {
  const data = await graphPost(`/${cfg.pageId}/photos`, {
    url: input.imageUrl,
    caption: input.caption.slice(0, 2200),
    access_token: cfg.pageAccessToken,
  });
  return { id: data.id };
}

export interface IgConfig {
  igUserId: string;
  accessToken: string;
}

export function loadInstagramConfig(): IgConfig | null {
  const { IG_USER_ID, IG_ACCESS_TOKEN } = process.env;
  if (!IG_USER_ID || !IG_ACCESS_TOKEN) return null;
  return { igUserId: IG_USER_ID, accessToken: IG_ACCESS_TOKEN };
}

/** Publish a photo to Instagram (container → publish). */
export async function publishInstagramPhoto(
  cfg: IgConfig,
  input: { imageUrl: string; caption: string },
): Promise<{ id: string }> {
  const container = await graphPost(`/${cfg.igUserId}/media`, {
    image_url: input.imageUrl,
    caption: input.caption.slice(0, 2200),
    access_token: cfg.accessToken,
  });
  if (!container?.id) throw new Error('Instagram did not return a media container id.');
  const published = await graphPost(`/${cfg.igUserId}/media_publish`, {
    creation_id: container.id,
    access_token: cfg.accessToken,
  });
  return { id: published.id };
}
