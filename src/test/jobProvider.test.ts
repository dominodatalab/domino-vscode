import { JobProvider } from '../jobProvider';

function makeMockClient(overrides: {
    isAuthenticated?: boolean;
    currentProjectId?: string | null;
    jobs?: any[];
    hasMore?: boolean;
    total?: number;
} = {}) {
    return {
        isAuthenticated: overrides.isAuthenticated ?? true,
        currentProjectId: 'currentProjectId' in overrides ? overrides.currentProjectId : 'proj-1',
        getJobs: jest.fn().mockResolvedValue({
            jobs: overrides.jobs ?? [],
            hasMore: overrides.hasMore ?? false,
            total: overrides.total ?? 0,
        }),
    };
}

describe('JobProvider – refresh', () => {
    it('resets pagination state to initial values', async () => {
        const mockClient = makeMockClient({ jobs: [], total: 0 });
        const provider = new JobProvider(mockClient as any);

        // Simulate loading some jobs that bump the offset via loadMore
        await provider.loadMore();
        expect((provider as any).currentOffset).toBe(20);

        provider.refresh();

        expect((provider as any).currentOffset).toBe(0);
        expect((provider as any).jobs).toEqual([]);
        expect((provider as any).hasMore).toBe(false);
        expect((provider as any).total).toBe(0);
    });
});

describe('JobProvider – loadMore', () => {
    it('increments currentOffset by pageSize', async () => {
        const provider = new JobProvider(makeMockClient() as any);
        expect((provider as any).currentOffset).toBe(0);

        await provider.loadMore();
        expect((provider as any).currentOffset).toBe(20);

        await provider.loadMore();
        expect((provider as any).currentOffset).toBe(40);
    });
});

describe('JobProvider – getChildren when not authenticated', () => {
    it('returns empty array', async () => {
        const provider = new JobProvider(makeMockClient({ isAuthenticated: false }) as any);

        const items = await provider.getChildren();

        expect(items).toEqual([]);
    });
});

describe('JobProvider – getChildren with no project selected', () => {
    it('returns a project-needed header and action item', async () => {
        const provider = new JobProvider(
            makeMockClient({ currentProjectId: null }) as any
        );

        const items = await provider.getChildren();

        expect(items).toHaveLength(2);
        expect(items[0].label).toMatch(/select a project/i);
        expect(items[1].contextValue).toBe('jobAction');
    });
});

describe('JobProvider – getChildren with empty job list', () => {
    it('shows no-jobs header, action button, and help text', async () => {
        const provider = new JobProvider(makeMockClient({ jobs: [], total: 0 }) as any);

        const items = await provider.getChildren();

        const labels = items.map(i => i.label as string);
        expect(labels.some(l => /no jobs/i.test(l))).toBe(true);
        expect(items.some(i => i.contextValue === 'jobAction')).toBe(true);
    });
});

describe('JobProvider – getChildren with jobs', () => {
    const sampleJobs = [
        {
            id: 'job-1',
            number: 1,
            title: 'Training Run',
            jobRunCommand: 'python train.py',
            statuses: { executionStatus: 'Succeeded' },
            stageTime: { completedTime: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
            startedBy: { username: 'alice' },
        },
        {
            id: 'job-2',
            number: 2,
            title: 'Evaluation',
            jobRunCommand: 'python eval.py',
            statuses: { executionStatus: 'Failed' },
            stageTime: { completedTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
            startedBy: { username: 'bob' },
        },
    ];

    it('returns header + action + job items on fresh load', async () => {
        const provider = new JobProvider(
            makeMockClient({ jobs: sampleJobs, total: 2 }) as any
        );

        const items = await provider.getChildren();

        // Should include: 1 summary header, 1 action, 2 job items
        expect(items.length).toBeGreaterThanOrEqual(4);
    });

    it('job items have contextValue "job"', async () => {
        const provider = new JobProvider(
            makeMockClient({ jobs: sampleJobs, total: 2 }) as any
        );

        const items = await provider.getChildren();
        const jobItems = items.filter(i => i.contextValue === 'job');

        expect(jobItems).toHaveLength(2);
    });

    it('job item label matches job title', async () => {
        const provider = new JobProvider(
            makeMockClient({ jobs: sampleJobs, total: 2 }) as any
        );

        const items = await provider.getChildren();
        const jobItems = items.filter(i => i.contextValue === 'job');

        expect(jobItems.map(j => j.label)).toEqual(['#1 Training Run', '#2 Evaluation']);
    });

    it('shows summary header with total count', async () => {
        const provider = new JobProvider(
            makeMockClient({ jobs: sampleJobs, total: 42 }) as any
        );

        const items = await provider.getChildren();
        const summaryItem = items.find(i => (i.label as string).includes('42'));

        expect(summaryItem).toBeDefined();
    });

    it('adds a LoadMoreItem when hasMore is true', async () => {
        const provider = new JobProvider(
            makeMockClient({ jobs: sampleJobs, hasMore: true, total: 100 }) as any
        );

        const items = await provider.getChildren();
        const loadMore = items.find(i => i.contextValue === 'loadMore');

        expect(loadMore).toBeDefined();
    });

    it('does not add a LoadMoreItem when hasMore is false', async () => {
        const provider = new JobProvider(
            makeMockClient({ jobs: sampleJobs, hasMore: false, total: 2 }) as any
        );

        const items = await provider.getChildren();
        const loadMore = items.find(i => i.contextValue === 'loadMore');

        expect(loadMore).toBeUndefined();
    });

    it('appends jobs on subsequent pages instead of replacing', async () => {
        const mockClient = makeMockClient({ jobs: sampleJobs, hasMore: true, total: 4 });
        const provider = new JobProvider(mockClient as any);

        await provider.getChildren();
        const firstPageJobs = (provider as any).jobs.length;
        expect(firstPageJobs).toBe(2);

        // Simulate loading more
        await provider.loadMore();

        const page2Jobs = [
            { id: 'job-3', number: 3, title: 'Job 3', jobRunCommand: 'cmd', statuses: {}, stageTime: {}, startedBy: { username: 'alice' } },
            { id: 'job-4', number: 4, title: 'Job 4', jobRunCommand: 'cmd', statuses: {}, stageTime: {}, startedBy: { username: 'alice' } },
        ];
        mockClient.getJobs.mockResolvedValueOnce({ jobs: page2Jobs, hasMore: false, total: 4 });

        await provider.getChildren();

        expect((provider as any).jobs.length).toBe(4);
    });
});

describe('JobProvider – time ago formatting', () => {
    it('shows time in minutes for recent jobs', async () => {
        const completedTime = new Date(Date.now() - 25 * 60 * 1000).toISOString();
        const jobs = [{
            id: 'j1', number: 1, title: 'Recent Job',
            jobRunCommand: 'cmd',
            statuses: { executionStatus: 'Succeeded' },
            stageTime: { completedTime },
            startedBy: { username: 'alice' },
        }];

        const provider = new JobProvider(
            makeMockClient({ jobs, total: 1 }) as any
        );

        const items = await provider.getChildren();
        const jobItem = items.find(i => i.contextValue === 'job')!;

        expect(jobItem.description as string).toContain('m ago');
    });

    it('shows time in hours for jobs completed hours ago', async () => {
        const completedTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        const jobs = [{
            id: 'j1', number: 1, title: 'Old Job',
            jobRunCommand: 'cmd',
            statuses: { executionStatus: 'Succeeded' },
            stageTime: { completedTime },
            startedBy: { username: 'alice' },
        }];

        const provider = new JobProvider(
            makeMockClient({ jobs, total: 1 }) as any
        );

        const items = await provider.getChildren();
        const jobItem = items.find(i => i.contextValue === 'job')!;

        expect(jobItem.description as string).toContain('h ago');
    });

    it('shows "running" for jobs with only a runStartTime', async () => {
        const jobs = [{
            id: 'j1', number: 1, title: 'Running Job',
            jobRunCommand: 'cmd',
            statuses: { executionStatus: 'Running' },
            stageTime: { runStartTime: new Date().toISOString() },
            startedBy: { username: 'alice' },
        }];

        const provider = new JobProvider(
            makeMockClient({ jobs, total: 1 }) as any
        );

        const items = await provider.getChildren();
        const jobItem = items.find(i => i.contextValue === 'job-running')!;

        expect(jobItem.description as string).toContain('running');
    });
});

describe('JobProvider – error handling', () => {
    it('returns error items when getJobs throws', async () => {
        const mockClient = {
            isAuthenticated: true,
            currentProjectId: 'proj-1',
            getJobs: jest.fn().mockRejectedValue(new Error('API error')),
        };
        const provider = new JobProvider(mockClient as any);

        const items = await provider.getChildren();

        expect(items.some(i => (i.label as string).toLowerCase().includes('error'))).toBe(true);
    });
});
