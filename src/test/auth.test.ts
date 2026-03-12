import axios from 'axios';
import { refreshAccessToken, revokeTokens, storeTokens, loadTokens, clearTokens, TokenSet } from '../auth';

jest.mock('axios');
const mockAxios = axios as jest.Mocked<typeof axios>;

const baseTokens: TokenSet = {
    accessToken: 'access-token-123',
    refreshToken: 'refresh-token-abc',
    idToken: 'id-token-xyz',
    expiresAt: Date.now() + 3600000,
    dominoBaseUrl: 'https://domino.example.com',
};

const mockStorage = {
    get: jest.fn(),
    store: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    onDidChange: jest.fn(),
};

describe('refreshAccessToken', () => {
    beforeEach(() => jest.clearAllMocks());

    it('posts to the token endpoint with correct params', async () => {
        mockAxios.post.mockResolvedValueOnce({
            data: {
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                id_token: 'new-id',
                expires_in: 3600,
            },
        });

        await refreshAccessToken(baseTokens, 'my-client');

        expect(mockAxios.post).toHaveBeenCalledWith(
            'https://domino.example.com/auth/realms/DominoRealm/protocol/openid-connect/token',
            expect.stringContaining('grant_type=refresh_token'),
            expect.objectContaining({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        );
        const body = mockAxios.post.mock.calls[0][1] as string;
        expect(body).toContain('client_id=my-client');
        expect(body).toContain('refresh_token=refresh-token-abc');
    });

    it('returns a new TokenSet with updated tokens and expiresAt', async () => {
        const beforeCall = Date.now();
        mockAxios.post.mockResolvedValueOnce({
            data: {
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                id_token: 'new-id',
                expires_in: 3600,
            },
        });

        const result = await refreshAccessToken(baseTokens, 'my-client');

        expect(result.accessToken).toBe('new-access');
        expect(result.refreshToken).toBe('new-refresh');
        expect(result.idToken).toBe('new-id');
        expect(result.dominoBaseUrl).toBe('https://domino.example.com');
        expect(result.expiresAt).toBeGreaterThanOrEqual(beforeCall + 3600000);
    });

    it('falls back to old refresh token when server does not rotate it', async () => {
        mockAxios.post.mockResolvedValueOnce({
            data: {
                access_token: 'new-access',
                refresh_token: null, // server omitted rotation
                expires_in: 3600,
            },
        });

        const result = await refreshAccessToken(baseTokens, 'my-client');

        expect(result.refreshToken).toBe('refresh-token-abc');
    });
});

describe('revokeTokens', () => {
    beforeEach(() => jest.clearAllMocks());

    it('posts to the revocation endpoint with the refresh token', async () => {
        mockAxios.post.mockResolvedValueOnce({ data: {} });

        await revokeTokens(baseTokens, 'my-client');

        expect(mockAxios.post).toHaveBeenCalledWith(
            'https://domino.example.com/auth/realms/DominoRealm/protocol/openid-connect/revoke',
            expect.stringContaining('token_type_hint=refresh_token'),
            expect.any(Object)
        );
        const body = mockAxios.post.mock.calls[0][1] as string;
        expect(body).toContain('token=refresh-token-abc');
    });

    it('does not throw when revocation request fails', async () => {
        mockAxios.post.mockRejectedValueOnce(new Error('Network error'));

        // Should resolve without throwing
        await expect(revokeTokens(baseTokens, 'my-client')).resolves.toBeUndefined();
    });
});

describe('storeTokens / loadTokens / clearTokens', () => {
    beforeEach(() => jest.clearAllMocks());

    it('storeTokens serializes the token set to JSON', async () => {
        await storeTokens(mockStorage as any, baseTokens);

        expect(mockStorage.store).toHaveBeenCalledWith(
            'domino.oauthTokens',
            JSON.stringify(baseTokens)
        );
    });

    it('loadTokens returns parsed TokenSet when stored value exists', async () => {
        mockStorage.get.mockResolvedValueOnce(JSON.stringify(baseTokens));

        const result = await loadTokens(mockStorage as any);

        expect(result).toEqual(baseTokens);
    });

    it('loadTokens returns null when nothing is stored', async () => {
        mockStorage.get.mockResolvedValueOnce(null);

        const result = await loadTokens(mockStorage as any);

        expect(result).toBeNull();
    });

    it('loadTokens returns null when stored value is malformed JSON', async () => {
        mockStorage.get.mockResolvedValueOnce('not-valid-json{');

        const result = await loadTokens(mockStorage as any);

        expect(result).toBeNull();
    });

    it('clearTokens deletes the storage key', async () => {
        await clearTokens(mockStorage as any);

        expect(mockStorage.delete).toHaveBeenCalledWith('domino.oauthTokens');
    });
});
