import { ProjectProvider } from '../projectProvider';
import { TreeItemCollapsibleState } from 'vscode';

function makeMockClient(projects: any[] = []) {
    return {
        isAuthenticated: true,
        currentProjectId: 'proj-1',
        getProjects: jest.fn().mockResolvedValue(projects),
    };
}

describe('ProjectProvider – getChildren (root level)', () => {
    it('returns empty array when getProjects returns empty list', async () => {
        const provider = new ProjectProvider(makeMockClient([]) as any);

        const items = await provider.getChildren();

        expect(items).toHaveLength(0);
    });

    it('groups projects by ownerUsername into OwnerItems', async () => {
        const provider = new ProjectProvider(
            makeMockClient([
                { id: '1', name: 'Alpha', ownerUsername: 'alice', description: '' },
                { id: '2', name: 'Beta', ownerUsername: 'bob', description: '' },
                { id: '3', name: 'Gamma', ownerUsername: 'alice', description: '' },
            ]) as any
        );

        const items = await provider.getChildren();

        expect(items).toHaveLength(2);
        const labels = items.map(i => i.label);
        expect(labels).toContain('alice');
        expect(labels).toContain('bob');
    });

    it('sorts owner groups alphabetically', async () => {
        const provider = new ProjectProvider(
            makeMockClient([
                { id: '1', name: 'P1', ownerUsername: 'zara', description: '' },
                { id: '2', name: 'P2', ownerUsername: 'alice', description: '' },
                { id: '3', name: 'P3', ownerUsername: 'bob', description: '' },
            ]) as any
        );

        const items = await provider.getChildren();

        expect(items.map(i => i.label)).toEqual(['alice', 'bob', 'zara']);
    });

    it('shows project count in OwnerItem description', async () => {
        const provider = new ProjectProvider(
            makeMockClient([
                { id: '1', name: 'A', ownerUsername: 'alice', description: '' },
                { id: '2', name: 'B', ownerUsername: 'alice', description: '' },
            ]) as any
        );

        const items = await provider.getChildren();

        expect(items[0].description).toBe('2 projects');
    });

    it('uses "Unknown" as fallback for missing ownerUsername', async () => {
        const provider = new ProjectProvider(
            makeMockClient([
                { id: '1', name: 'P1', description: '' }, // no ownerUsername
            ]) as any
        );

        const items = await provider.getChildren();

        expect(items[0].label).toBe('Unknown');
    });

    it('returns empty array when getProjects throws', async () => {
        const mockClient = {
            getProjects: jest.fn().mockRejectedValue(new Error('API error')),
        };
        const provider = new ProjectProvider(mockClient as any);

        const items = await provider.getChildren();

        expect(items).toEqual([]);
    });
});

describe('ProjectProvider – getChildren (owner level)', () => {
    it('returns ProjectItems for the given owner', async () => {
        const provider = new ProjectProvider(
            makeMockClient([
                { id: '1', name: 'Alpha', ownerUsername: 'alice', description: 'Desc A' },
                { id: '2', name: 'Beta', ownerUsername: 'alice', description: 'Desc B' },
                { id: '3', name: 'Gamma', ownerUsername: 'bob', description: 'Desc C' },
            ]) as any
        );

        // Populate internal state by calling root getChildren first
        const ownerItems = await provider.getChildren();
        const aliceItem = ownerItems.find(i => i.label === 'alice')!;

        const projects = await provider.getChildren(aliceItem as any);

        expect(projects).toHaveLength(2);
        expect(projects.map(p => p.label)).toEqual(['Alpha', 'Beta']);
    });

    it('sets contextValue to "project" on ProjectItems', async () => {
        const provider = new ProjectProvider(
            makeMockClient([
                { id: '1', name: 'Alpha', ownerUsername: 'alice', description: '' },
            ]) as any
        );

        const ownerItems = await provider.getChildren();
        const projectItems = await provider.getChildren(ownerItems[0] as any);

        expect(projectItems[0].contextValue).toBe('project');
    });

    it('sets collapsibleState to None on ProjectItems', async () => {
        const provider = new ProjectProvider(
            makeMockClient([
                { id: '1', name: 'Alpha', ownerUsername: 'alice', description: '' },
            ]) as any
        );

        const ownerItems = await provider.getChildren();
        const projectItems = await provider.getChildren(ownerItems[0] as any);

        expect(projectItems[0].collapsibleState).toBe(TreeItemCollapsibleState.None);
    });
});

describe('ProjectProvider – refresh', () => {
    it('clears cached projects and fires change event', async () => {
        const mockClient = makeMockClient([
            { id: '1', name: 'P1', ownerUsername: 'alice', description: '' },
        ]);
        const provider = new ProjectProvider(mockClient as any);

        // Populate cache
        await provider.getChildren();
        expect(mockClient.getProjects).toHaveBeenCalledTimes(1);

        provider.refresh();

        // After refresh, calling getChildren again should re-fetch
        await provider.getChildren();
        expect(mockClient.getProjects).toHaveBeenCalledTimes(2);
    });
});
