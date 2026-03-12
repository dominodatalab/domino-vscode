import { WorkspaceProvider } from '../workspaceProvider';

function makeMockClient(overrides: {
    isAuthenticated?: boolean;
    currentProjectId?: string | null;
    workspaces?: any[];
} = {}) {
    return {
        isAuthenticated: overrides.isAuthenticated ?? true,
        currentProjectId: 'currentProjectId' in overrides ? overrides.currentProjectId : 'proj-1',
        apiHost: 'domino.example.com',
        getWorkspaces: jest.fn().mockResolvedValue(overrides.workspaces ?? []),
    };
}

describe('WorkspaceProvider – getChildren when not authenticated', () => {
    it('returns empty array', async () => {
        const provider = new WorkspaceProvider(
            makeMockClient({ isAuthenticated: false }) as any
        );

        const items = await provider.getChildren();

        expect(items).toEqual([]);
    });
});

describe('WorkspaceProvider – getChildren with no project selected', () => {
    it('returns a project-needed header', async () => {
        const provider = new WorkspaceProvider(
            makeMockClient({ currentProjectId: null }) as any
        );

        const items = await provider.getChildren();

        expect(items).toHaveLength(1);
        expect(items[0].label).toMatch(/select a project/i);
        expect(items[0].contextValue).toBe('workspaceHeader');
    });
});

describe('WorkspaceProvider – getChildren with empty workspace list', () => {
    it('shows no-workspaces header and create action', async () => {
        const provider = new WorkspaceProvider(
            makeMockClient({ workspaces: [] }) as any
        );

        const items = await provider.getChildren();

        expect(items.some(i => (i.label as string).toLowerCase().includes('no workspaces'))).toBe(true);
        expect(items.some(i => i.contextValue === 'workspaceAction')).toBe(true);
    });
});

describe('WorkspaceProvider – getChildren with workspaces', () => {
    const sampleWorkspaces = [
        { id: 'ws-1', name: 'Dev Env', state: 'Started', ownerName: 'alice', createdAt: new Date().toISOString() },
        { id: 'ws-2', name: 'Test Env', state: 'Stopped', ownerName: 'alice', createdAt: new Date().toISOString() },
    ];

    it('includes a summary header, create action, and workspace items', async () => {
        const provider = new WorkspaceProvider(
            makeMockClient({ workspaces: sampleWorkspaces }) as any
        );

        const items = await provider.getChildren();

        expect(items.some(i => i.contextValue === 'workspaceHeader')).toBe(true);
        expect(items.some(i => i.contextValue === 'workspaceAction')).toBe(true);
        expect(items.filter(i => ['workspace-running', 'workspace-stopped', 'workspace-running-ssh'].includes(i.contextValue ?? ''))).toHaveLength(2);
    });

    it('summary includes running and stopped counts', async () => {
        const provider = new WorkspaceProvider(
            makeMockClient({ workspaces: sampleWorkspaces }) as any
        );

        const items = await provider.getChildren();
        const summary = items.find(i => i.contextValue === 'workspaceHeader' && (i.label as string).includes('running'));

        expect(summary).toBeDefined();
        expect(summary!.label as string).toContain('1 running');
        expect(summary!.label as string).toContain('1 stopped');
    });

    it('workspace contextValue is "workspace-running" for Started state', async () => {
        const provider = new WorkspaceProvider(
            makeMockClient({ workspaces: [
                { id: 'ws-1', name: 'Dev', state: 'Started', ownerName: 'alice', createdAt: '' },
            ] }) as any
        );

        const items = await provider.getChildren();
        const wsItem = items.find(i => i.contextValue?.startsWith('workspace-running'));

        expect(wsItem).toBeDefined();
        expect(wsItem!.contextValue).toBe('workspace-running');
    });

    it('workspace contextValue is "workspace-running" for Running state', async () => {
        const provider = new WorkspaceProvider(
            makeMockClient({ workspaces: [
                { id: 'ws-1', name: 'Dev', state: 'Running', ownerName: 'alice', createdAt: '' },
            ] }) as any
        );

        const items = await provider.getChildren();
        const wsItem = items.find(i => i.contextValue?.startsWith('workspace-running'));

        expect(wsItem!.contextValue).toBe('workspace-running');
    });

    it('workspace contextValue is "workspace-stopped" for Stopped state', async () => {
        const provider = new WorkspaceProvider(
            makeMockClient({ workspaces: [
                { id: 'ws-1', name: 'Dev', state: 'Stopped', ownerName: 'alice', createdAt: '' },
            ] }) as any
        );

        const items = await provider.getChildren();
        const wsItem = items.find(i => i.contextValue === 'workspace-stopped');

        expect(wsItem).toBeDefined();
    });

    it('workspace contextValue is "workspace-running-ssh" when tunnel is active', async () => {
        const activeTunnels = new Map([['ws-1', { port: 2222 }]]);
        const provider = new WorkspaceProvider(
            makeMockClient({ workspaces: [
                { id: 'ws-1', name: 'Dev', state: 'Started', ownerName: 'alice', createdAt: '' },
            ] }) as any,
            activeTunnels
        );

        const items = await provider.getChildren();
        const wsItem = items.find(i => i.contextValue === 'workspace-running-ssh');

        expect(wsItem).toBeDefined();
    });

    it('SSH port appears in item description when tunnel is active', async () => {
        const activeTunnels = new Map([['ws-1', { port: 2222 }]]);
        const provider = new WorkspaceProvider(
            makeMockClient({ workspaces: [
                { id: 'ws-1', name: 'Dev', state: 'Started', ownerName: 'alice', createdAt: '' },
            ] }) as any,
            activeTunnels
        );

        const items = await provider.getChildren();
        const wsItem = items.find(i => i.contextValue === 'workspace-running-ssh')!;

        expect(wsItem.description as string).toContain(':2222');
    });
});

describe('WorkspaceProvider – error handling', () => {
    it('returns error items when getWorkspaces throws', async () => {
        const mockClient = {
            isAuthenticated: true,
            currentProjectId: 'proj-1',
            apiHost: 'domino.example.com',
            getWorkspaces: jest.fn().mockRejectedValue(new Error('API error')),
        };
        const provider = new WorkspaceProvider(mockClient as any);

        const items = await provider.getChildren();

        expect(items.some(i => (i.label as string).toLowerCase().includes('error'))).toBe(true);
    });
});
