import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import * as vscode from 'vscode';
import axios from 'axios';

export interface TokenSet {
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    /** Unix timestamp in milliseconds when the access token expires */
    expiresAt: number;
    dominoBaseUrl: string;
}

const STORAGE_KEY = 'domino.oauthTokens';

// --- PKCE helpers ---

function base64URLEncode(buffer: Buffer): string {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = base64URLEncode(crypto.randomBytes(32));
    const codeChallenge = base64URLEncode(
        crypto.createHash('sha256').update(codeVerifier).digest()
    );
    return { codeVerifier, codeChallenge };
}

// --- Local callback server ---

function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

function startCallbackServer(port: number): Promise<{ code: string; state: string }> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (!req.url) { return; }

            const url = new URL(req.url, `http://localhost:${port}`);
            if (url.pathname !== '/callback') { return; }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                '<html><head><title>Domino Authentication</title></head>' +
                '<body style="font-family:sans-serif;padding:2rem;">' +
                '<h2>Authentication complete.</h2>' +
                '<p>You can close this tab and return to VS Code.</p>' +
                '<script>window.close();</script>' +
                '</body></html>'
            );

            server.close();

            if (error) {
                reject(new Error(`Authentication cancelled or failed: ${error}`));
            } else if (code && state) {
                resolve({ code, state });
            } else {
                reject(new Error('Invalid OAuth callback: missing code or state'));
            }
        });

        server.on('error', reject);

        server.listen(port, '127.0.0.1', () => {
            // Timeout after 5 minutes in case the user abandons the browser flow
            const timeout = setTimeout(() => {
                server.close();
                reject(new Error('Authentication timed out'));
            }, 5 * 60 * 1000);

            server.once('close', () => clearTimeout(timeout));
        });
    });
}

// --- OAuth PKCE flow ---

export async function performOAuthFlow(dominoBaseUrl: string, clientId: string): Promise<TokenSet> {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = crypto.randomUUID();
    const port = await findFreePort();
    const redirectUri = `http://localhost:${port}/callback`;

    const authParams = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        scope: 'openid profile email domino-jwt-claims',
    });

    const authUrl = `${dominoBaseUrl}/auth/realms/DominoRealm/protocol/openid-connect/auth?${authParams}`;

    // Start the callback listener before opening the browser so we don't miss the redirect
    const callbackPromise = startCallbackServer(port);

    await vscode.env.openExternal(vscode.Uri.parse(authUrl));

    const { code, state: returnedState } = await callbackPromise;

    if (returnedState !== state) {
        throw new Error('OAuth state mismatch — possible CSRF attack, please try again');
    }

    const tokenResponse = await axios.post(
        `${dominoBaseUrl}/auth/realms/DominoRealm/protocol/openid-connect/token`,
        new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const data = tokenResponse.data;

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        idToken: data.id_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
        dominoBaseUrl,
    };
}

// --- Token refresh ---

export async function refreshAccessToken(tokens: TokenSet, clientId: string): Promise<TokenSet> {
    const response = await axios.post(
        `${tokens.dominoBaseUrl}/auth/realms/DominoRealm/protocol/openid-connect/token`,
        new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: tokens.refreshToken,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const data = response.data;

    return {
        accessToken: data.access_token,
        // Some Keycloak configurations rotate refresh tokens; fall back to the old one if not rotated
        refreshToken: data.refresh_token || tokens.refreshToken,
        idToken: data.id_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
        dominoBaseUrl: tokens.dominoBaseUrl,
    };
}

// --- Token revocation ---

export async function revokeTokens(tokens: TokenSet, clientId: string): Promise<void> {
    try {
        await axios.post(
            `${tokens.dominoBaseUrl}/auth/realms/DominoRealm/protocol/openid-connect/revoke`,
            new URLSearchParams({
                client_id: clientId,
                token: tokens.refreshToken,
                token_type_hint: 'refresh_token',
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
    } catch (error) {
        // Revocation failure should not block sign-out
        console.warn('Token revocation failed (continuing with local sign-out):', error);
    }
}

// --- Secure token storage via VS Code SecretStorage ---

export async function storeTokens(storage: vscode.SecretStorage, tokens: TokenSet): Promise<void> {
    await storage.store(STORAGE_KEY, JSON.stringify(tokens));
}

export async function loadTokens(storage: vscode.SecretStorage): Promise<TokenSet | null> {
    const stored = await storage.get(STORAGE_KEY);
    if (!stored) { return null; }
    try {
        return JSON.parse(stored) as TokenSet;
    } catch {
        return null;
    }
}

export async function clearTokens(storage: vscode.SecretStorage): Promise<void> {
    await storage.delete(STORAGE_KEY);
}
