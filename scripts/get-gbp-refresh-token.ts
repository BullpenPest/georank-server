/**
 * One-time helper: mint the long-lived GBP refresh token for server/.env.
 *
 * What it does:
 *  1. Builds a Google OAuth consent URL for the `business.manage` scope
 *     (the exact scope server/src/gbp.ts requests).
 *  2. Opens it in your browser — sign in as the Google account that OWNS
 *     the Business Profile location.
 *  3. Captures the callback on http://localhost:3999/oauth2callback,
 *     exchanges the code, and prints GBP_REFRESH_TOKEN for your .env.
 *
 * Before running:
 *  - Create the OAuth client (type "Web application") in Google Cloud Console
 *    → APIs & Services → Credentials, and add
 *      http://localhost:3999/oauth2callback
 *    to its Authorized redirect URIs.
 *  - Set GBP_CLIENT_ID and GBP_CLIENT_SECRET in your environment
 *    (e.g. `export GBP_CLIENT_ID=...` or prefix the npm command).
 *
 * Run:  npm run gbp:token
 *
 * Notes:
 *  - `access_type=offline` + `prompt=consent` forces Google to return a
 *    refresh token even if you've granted this app before.
 *  - While the OAuth consent screen is in "Testing" publishing status,
 *    refresh tokens expire after 7 days. For a server that publishes in the
 *    background, publish the consent screen (requires verification for the
 *    sensitive business.manage scope) before going live.
 */
import { google } from 'googleapis';
import * as http from 'http';
import { exec } from 'child_process';

const PORT = 3999;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
// Must match GBP_SCOPES in src/gbp.ts
const SCOPES = ['https://www.googleapis.com/auth/business.manage'];

const CLIENT_ID = process.env.GBP_CLIENT_ID;
const CLIENT_SECRET = process.env.GBP_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    'Set GBP_CLIENT_ID and GBP_CLIENT_SECRET first (see server/.env.example).\n' +
      'Example: GBP_CLIENT_ID=... GBP_CLIENT_SECRET=... npm run gbp:token',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const err = url.searchParams.get('error');
      if (err) {
        res.writeHead(400).end(`OAuth error: ${err}. You can close this tab.`);
        console.error(`OAuth error: ${err}`);
        server.close();
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400).end('No authorization code received. You can close this tab.');
        server.close();
        return;
      }
      const { tokens } = await oauth2Client.getToken(code);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Done — copy the refresh token from your terminal. You can close this tab.');
      if (!tokens.refresh_token) {
        console.error(
          '\nNo refresh token was returned. This happens if the app already had a ' +
            'grant without offline access — revoke it at ' +
            'https://myaccount.google.com/permissions and re-run.\n',
        );
      } else {
        console.log('\n=== GBP_REFRESH_TOKEN (paste into server/.env) ===');
        console.log(tokens.refresh_token);
        console.log('==================================================\n');
      }
      server.close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Token exchange failed:', msg);
      try {
        res.writeHead(500).end('Token exchange failed — see the terminal for details.');
      } catch {
        /* response already sent */
      }
      server.close();
    }
  });

  server.listen(PORT, () => {
    console.log(
      `\n1. Confirm this redirect URI is authorized on your OAuth client:\n   ${REDIRECT_URI}\n` +
        '2. Opening the Google consent screen — sign in as the Google account\n' +
        '   that OWNS the Business Profile location.\n',
    );
    console.log(authUrl + '\n');
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${opener} "${authUrl}"`, () => {
      /* browser opened (or not) — the URL above works either way */
    });
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
