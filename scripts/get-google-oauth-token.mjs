import http from 'node:http';
import { URL } from 'node:url';
import { execFile } from 'node:child_process';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const port = Number(process.env.GOOGLE_OAUTH_PORT || 4587);
const redirectUri = `http://localhost:${port}/oauth2callback`;

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
    res.end('OAuth complete. You can close this tab.');
    console.log('\nRefresh token:');
    console.log(token.refresh_token || '(no refresh token returned; rerun with prompt=consent or revoke app access first)');
    console.log('\nFull token response:');
    console.log(JSON.stringify(token, null, 2));
  } catch (error) {
    console.error(error);
    res.end('OAuth failed. Check terminal output.');
  } finally {
    server.close();
  }
});

server.listen(port, () => {
  console.log(`Open this URL and approve Drive access:\n${authUrl.toString()}\n`);
  execFile('xdg-open', [authUrl.toString()], () => {});
});
