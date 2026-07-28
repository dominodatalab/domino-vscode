import { DominoApiClient } from '../dominoApiClient';

// Minimal mock HTTP client injected directly into private field
function makeMockHttpClient() {
    return {
        get: jest.fn(),
        post: jest.fn(),
        interceptors: { request: { use: jest.fn() } },
    };
}

function makeAuthenticatedClient(overrides: { projectId?: string } = {}) {
    const client = new DominoApiClient();
    const http = makeMockHttpClient();
    (client as any).httpClient = http;
    (client as any).accessToken = 'test-token';
    (client as any)._apiUrl = 'https://domino.example.com';
    if (overrides.projectId !== undefined) {
        (client as any).currentProjectId = overrides.projectId;
    } else {
        (client as any).currentProjectId = 'project-abc';
    }
    return { client, http };
}

describe('DominoApiClient – initial state', () => {
    it('is not authenticated by default', () => {
        const client = new DominoApiClient();
        expect(client.isAuthenticated).toBe(false);
    });

    it('has null project fields by default', () => {
        const client = new DominoApiClient();
        expect(client.currentProjectId).toBeNull();
        expect(client.currentProjectName).toBeNull();
    });
});

describe('DominoApiClient – clearAuth', () => {
    it('resets all auth state', () => {
        const { client } = makeAuthenticatedClient();
        client.currentProjectName = 'my-project';

        client.clearAuth();

        expect(client.isAuthenticated).toBe(false);
        expect(client.currentProjectId).toBeNull();
        expect(client.currentProjectName).toBeNull();
        expect(client.apiUrl).toBe('');
    });
});

describe('DominoApiClient – apiHost getter', () => {
    it('returns the hostname from a valid URL', () => {
        const client = new DominoApiClient();
        (client as any)._apiUrl = 'https://domino.example.com/some/path';
        expect(client.apiHost).toBe('domino.example.com');
    });

    it('returns the raw value when URL is invalid', () => {
        const client = new DominoApiClient();
        (client as any)._apiUrl = 'not-a-url';
        expect(client.apiHost).toBe('not-a-url');
    });
});

describe('DominoApiClient – setCurrentProject', () => {
    it('sets projectId and projectName', async () => {
        const { client } = makeAuthenticatedClient({ projectId: null as any });

        await client.setCurrentProject('proj-123', 'My Project');

        expect(client.currentProjectId).toBe('proj-123');
        expect(client.currentProjectName).toBe('My Project');
    });

    it('sets projectName to null when omitted', async () => {
        const { client } = makeAuthenticatedClient({ projectId: null as any });

        await client.setCurrentProject('proj-456');

        expect(client.currentProjectId).toBe('proj-456');
        expect(client.currentProjectName).toBeNull();
    });
});

describe('DominoApiClient – updateAccessToken', () => {
    it('updates the token used for requests', () => {
        const { client } = makeAuthenticatedClient();

        client.updateAccessToken('new-token-xyz');

        expect((client as any).accessToken).toBe('new-token-xyz');
    });
});

describe('DominoApiClient – getJobs pagination', () => {
    beforeEach(() => jest.clearAllMocks());

    it('calculates page_no = 1 for offset 0', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({ data: { jobs: [], totalCount: 0 } });

        await client.getJobs(20, 0);

        const url: string = http.get.mock.calls[0][0];
        expect(url).toContain('page_no=1');
        expect(url).toContain('page_size=20');
    });

    it('calculates page_no = 2 for offset 20 with pageSize 20', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({ data: { jobs: [], totalCount: 0 } });

        await client.getJobs(20, 20);

        const url: string = http.get.mock.calls[0][0];
        expect(url).toContain('page_no=2');
    });

    it('calculates page_no = 5 for offset 40 with pageSize 10', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({ data: { jobs: [], totalCount: 0 } });

        await client.getJobs(10, 40);

        const url: string = http.get.mock.calls[0][0];
        expect(url).toContain('page_no=5');
    });

    it('returns hasMore = true when more jobs remain', async () => {
        const { client, http } = makeAuthenticatedClient();
        const jobs = Array.from({ length: 20 }, (_, i) => ({ id: `job-${i}` }));
        http.get.mockResolvedValue({ data: { jobs, totalCount: 50 } });

        const result = await client.getJobs(20, 0);

        expect(result.hasMore).toBe(true);
        expect(result.total).toBe(50);
    });

    it('returns hasMore = false when all jobs are loaded', async () => {
        const { client, http } = makeAuthenticatedClient();
        const jobs = Array.from({ length: 5 }, (_, i) => ({ id: `job-${i}` }));
        http.get.mockResolvedValue({ data: { jobs, totalCount: 25 } });

        const result = await client.getJobs(20, 20);

        expect(result.hasMore).toBe(false);
    });

    it('returns empty result when response has no jobs data', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({ data: null });

        const result = await client.getJobs(20, 0);

        expect(result.jobs).toEqual([]);
        expect(result.hasMore).toBe(false);
    });

    it('throws when not authenticated', async () => {
        const client = new DominoApiClient();

        await expect(client.getJobs()).rejects.toThrow('Not authenticated');
    });

    it('throws when no project is selected', async () => {
        const { client } = makeAuthenticatedClient({ projectId: null as any });

        await expect(client.getJobs()).rejects.toThrow('no project selected');
    });
});

describe('DominoApiClient – getWorkspaces', () => {
    beforeEach(() => jest.clearAllMocks());

    it('filters workspaces to only those owned by the current user', async () => {
        const { client, http } = makeAuthenticatedClient();
        jest.spyOn(client, 'getSelf').mockResolvedValue({ id: 'user-1', userName: 'alice' });

        http.get.mockResolvedValue({
            data: [
                { id: 'ws-1', ownerId: 'user-1', name: 'My Workspace' },
                { id: 'ws-2', ownerId: 'user-2', name: 'Other Workspace' },
                { id: 'ws-3', ownerId: 'user-1', name: 'Another Mine' },
            ],
        });

        const result = await client.getWorkspaces();

        expect(result).toHaveLength(2);
        expect(result.map(ws => ws.id)).toEqual(['ws-1', 'ws-3']);
    });

    it('handles response.data.workspaces format', async () => {
        const { client, http } = makeAuthenticatedClient();
        jest.spyOn(client, 'getSelf').mockResolvedValue({ id: 'user-1', userName: 'alice' });

        http.get.mockResolvedValue({
            data: {
                workspaces: [{ id: 'ws-1', ownerId: 'user-1', name: 'Mine' }],
            },
        });

        const result = await client.getWorkspaces();

        expect(result).toHaveLength(1);
    });

    it('handles response.data.data format', async () => {
        const { client, http } = makeAuthenticatedClient();
        jest.spyOn(client, 'getSelf').mockResolvedValue({ id: 'user-1', userName: 'alice' });

        http.get.mockResolvedValue({
            data: { data: [{ id: 'ws-1', ownerId: 'user-1', name: 'Mine' }] },
        });

        const result = await client.getWorkspaces();

        expect(result).toHaveLength(1);
    });

    it('returns empty array when no workspaces in response', async () => {
        const { client, http } = makeAuthenticatedClient();
        jest.spyOn(client, 'getSelf').mockResolvedValue({ id: 'user-1', userName: 'alice' });
        http.get.mockResolvedValue({ data: {} });

        const result = await client.getWorkspaces();

        expect(result).toEqual([]);
    });

    it('returns empty array on HTTP error (non-throwing)', async () => {
        const { client, http } = makeAuthenticatedClient();
        jest.spyOn(client, 'getSelf').mockResolvedValue({ id: 'user-1', userName: 'alice' });
        http.get.mockRejectedValue(Object.assign(new Error('Network fail'), { response: { status: 500 } }));

        const result = await client.getWorkspaces();

        expect(result).toEqual([]);
    });

    it('fetches a single page when totalWorkspaceCount fits within the page size', async () => {
        const { client, http } = makeAuthenticatedClient();
        jest.spyOn(client, 'getSelf').mockResolvedValue({ id: 'user-1', userName: 'alice' });

        http.get.mockResolvedValue({
            data: {
                workspaces: [{ id: 'ws-1', ownerId: 'user-1', name: 'Mine' }],
                totalWorkspaceCount: 1,
                offset: 0,
                limit: 50,
            },
        });

        const result = await client.getWorkspaces();

        expect(result).toHaveLength(1);
        expect(http.get).toHaveBeenCalledTimes(1);
    });

    it('pages through results when totalWorkspaceCount exceeds one page', async () => {
        const { client, http } = makeAuthenticatedClient();
        jest.spyOn(client, 'getSelf').mockResolvedValue({ id: 'user-1', userName: 'alice' });

        const makePage = (offset: number, count: number) => ({
            data: {
                workspaces: Array.from({ length: count }, (_, i) => ({
                    id: `ws-${offset + i}`,
                    ownerId: 'user-1',
                    name: `Workspace ${offset + i}`,
                })),
                totalWorkspaceCount: 120,
                offset,
                limit: 50,
            },
        });

        http.get
            .mockResolvedValueOnce(makePage(0, 50))
            .mockResolvedValueOnce(makePage(50, 50))
            .mockResolvedValueOnce(makePage(100, 20));

        const result = await client.getWorkspaces();

        expect(http.get).toHaveBeenCalledTimes(3);
        expect(http.get.mock.calls[0][0]).toContain('offset=0');
        expect(http.get.mock.calls[1][0]).toContain('offset=50');
        expect(http.get.mock.calls[2][0]).toContain('offset=100');
        expect(result).toHaveLength(120);
    });

    it('stops paginating if a page returns fewer items than expected without reaching total', async () => {
        const { client, http } = makeAuthenticatedClient();
        jest.spyOn(client, 'getSelf').mockResolvedValue({ id: 'user-1', userName: 'alice' });

        http.get
            .mockResolvedValueOnce({
                data: { workspaces: [{ id: 'ws-0', ownerId: 'user-1' }], totalWorkspaceCount: 5, offset: 0, limit: 50 },
            })
            .mockResolvedValueOnce({ data: { workspaces: [], totalWorkspaceCount: 5, offset: 1, limit: 50 } });

        const result = await client.getWorkspaces();

        expect(http.get).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(1);
    });
});

describe('DominoApiClient – getHardwareTiers', () => {
    beforeEach(() => jest.clearAllMocks());

    it('transforms nested hwtResources structure', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({
            data: [
                {
                    hardwareTier: {
                        id: 'small-k8s',
                        name: 'Small',
                        hwtResources: { cores: 1, memory: { value: 4, unit: 'GiB' } },
                        gpuConfiguration: { numberOfGpus: 0 },
                        hwtFlags: { isDefault: true, isVisible: true },
                    },
                },
            ],
        });

        const result = await client.getHardwareTiers();

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            id: 'small-k8s',
            name: 'Small',
            cpu: 1,
            memory: 4,
            memoryUnit: 'GiB',
            gpus: 0,
            isDefault: true,
        });
    });

    it('filters out tiers where isVisible is false', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({
            data: [
                {
                    hardwareTier: {
                        id: 'visible',
                        name: 'Visible',
                        hwtFlags: { isVisible: true },
                    },
                },
                {
                    hardwareTier: {
                        id: 'hidden',
                        name: 'Hidden',
                        hwtFlags: { isVisible: false },
                    },
                },
            ],
        });

        const result = await client.getHardwareTiers();

        expect(result.map((t: any) => t.id)).toEqual(['visible']);
    });

    it('returns default tiers when 404 is returned', async () => {
        const { client, http } = makeAuthenticatedClient();
        const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
        http.get.mockRejectedValue(err);

        const result = await client.getHardwareTiers();

        expect(result.length).toBeGreaterThan(0);
        expect(result[0].id).toBe('small-k8s');
    });
});

describe('DominoApiClient – getEnvironments', () => {
    beforeEach(() => jest.clearAllMocks());

    it('places currentlySelectedEnvironment first and marks it as default', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({
            data: {
                currentlySelectedEnvironment: { id: 'env-1', name: 'Default Env', archived: false },
                environments: [
                    { id: 'env-2', name: 'Other Env', archived: false },
                ],
            },
        });

        const result = await client.getEnvironments();

        expect(result[0].id).toBe('env-1');
        expect(result[0].isDefault).toBe(true);
        expect(result[0].isCurrentlySelected).toBe(true);
        expect(result[1].id).toBe('env-2');
        expect(result[1].isDefault).toBe(false);
    });

    it('does not duplicate the currently selected environment in the list', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({
            data: {
                currentlySelectedEnvironment: { id: 'env-1', name: 'Default Env', archived: false },
                environments: [
                    { id: 'env-1', name: 'Default Env', archived: false }, // duplicate
                    { id: 'env-2', name: 'Other Env', archived: false },
                ],
            },
        });

        const result = await client.getEnvironments();

        const ids = result.map((e: any) => e.id);
        expect(ids.filter((id: string) => id === 'env-1')).toHaveLength(1);
    });

    it('filters out archived environments', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({
            data: {
                currentlySelectedEnvironment: null,
                environments: [
                    { id: 'env-1', name: 'Active', archived: false },
                    { id: 'env-2', name: 'Archived', archived: true },
                ],
            },
        });

        const result = await client.getEnvironments();

        expect(result.map((e: any) => e.id)).toEqual(['env-1']);
    });

    it('handles plain array response format', async () => {
        const { client, http } = makeAuthenticatedClient();
        // First endpoint returns 404, second returns array
        const notFound = Object.assign(new Error('Not Found'), { response: { status: 404 } });
        http.get
            .mockRejectedValueOnce(notFound)  // useableEnvironments
            .mockResolvedValueOnce({
                data: [
                    { id: 'env-1', name: 'Env One', archived: false },
                ],
            });

        const result = await client.getEnvironments();

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('env-1');
    });

    it('returns empty array on all-404 responses', async () => {
        const { client, http } = makeAuthenticatedClient();
        const notFound = Object.assign(new Error('Not Found'), { response: { status: 404 } });
        http.get.mockRejectedValue(notFound);

        const result = await client.getEnvironments();

        expect(result).toEqual([]);
    });
});

describe('DominoApiClient – getJobLogs', () => {
    beforeEach(() => jest.clearAllMocks());

    it('sorts stdout entries by timestamp and returns lines', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({
            data: {
                logset: {
                    logContent: [
                        { timestamp: 2000, logType: 'stdout', log: 'second line' },
                        { timestamp: 1000, logType: 'stdout', log: 'first line' },
                    ],
                },
            },
        });

        const result = await client.getJobLogs('job-1');

        expect(result.stdout).toBe('first line\nsecond line');
    });

    it('sorts prepareoutput entries by timestamp and returns lines', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({
            data: {
                logset: {
                    logContent: [
                        { timestamp: 500, logType: 'prepareoutput', log: 'prepare second' },
                        { timestamp: 100, logType: 'prepareoutput', log: 'prepare first' },
                    ],
                },
            },
        });

        const result = await client.getJobLogs('job-1');

        expect(result.prepareOutput).toBe('prepare first\nprepare second');
    });

    it('returns (empty) when a stream has no entries', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({
            data: { logset: { logContent: [] } },
        });

        const result = await client.getJobLogs('job-1');

        expect(result.stdout).toBe('(empty)');
        expect(result.prepareOutput).toBe('(empty)');
    });

    it('uses correct endpoint', async () => {
        const { client, http } = makeAuthenticatedClient();
        http.get.mockResolvedValue({ data: { stdout: [], prepareoutput: [] } });

        await client.getJobLogs('abc123');

        expect(http.get.mock.calls[0][0]).toContain('/jobs/abc123/logsWithProblemSuggestions');
        expect(http.get.mock.calls[0][0]).toContain('logType=complete');
    });
});
