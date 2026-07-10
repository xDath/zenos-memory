import http from 'node:http';
import { URL } from 'node:url';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const port = Number(process.env.GOOGLE_OAUTH_PORT || 4587);
const redirectUri = `http://localhost:${port}/oauth2callback`;
const outputFile = process.env.GOOGLE_OAUTH_OUTPUT_FILE
  || path.join(homedir(), '.zenos-secrets', 'google-oauth-refresh-token.txt');

if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.');
  process.exit(1);
}

const scope = 'https://www.googleapis.com/auth/drive';
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', scope);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', redirectUri);
    if (url.pathname !== '/oauth2callback') {
      res.end('Waiting for OAuth callback...');
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      res.end('Missing code');
      return;
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    const token = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(`Google OAuth token exchange failed with HTTP ${tokenRes.status}`);
    }
    const refreshToken = typeof token?.refresh_token === 'string' ? token.refresh_token : '';
    if (!refreshToken) {
      throw new Error('Google OAuth returned no refresh token; revoke access and rerun with consent');
    }

    mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
    writeFileSync(outputFile, `${refreshToken}\n`, { mode: 0o600 });
    res.end('OAuth complete. The refresh token was stored in a protected local file. You can close this tab.');
    console.log(`OAuth refresh token stored securely at ${outputFile}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown OAuth failure';
    console.error(`OAuth failed: ${message}`);
    res.end('OAuth failed. Check terminal output.');
  } finally {
    server.close();
  }
});

server.listen(port, () => {
  console.log(`Open this URL and approve Drive access:\n${authUrl.toString()}\n`);
  execFile('xdg-open', [authUrl.toString()], () => {});
});
