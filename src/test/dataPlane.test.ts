import {
    LOCAL_DATA_PLANE_ID,
    buildDomConnectArgs,
    formatTierDataPlane,
    getRemoteDataPlaneHost,
    getWorkspaceDataPlane,
    isRemoteDataPlane,
} from '../dataPlane';

const API_URL = 'https://domino.example.com';

// Shapes taken from the /workspace/project/{projectId}/workspace response
const localWorkspace = {
    id: 'ws-local',
    dataPlaneId: LOCAL_DATA_PLANE_ID,
    configTemplate: {
        hardwareTier: { id: { value: 'small-k8s' }, name: 'Small', dataPlane: { id: LOCAL_DATA_PLANE_ID, name: 'Local' } },
        dataPlane: { host: 'domino.example.com' },
    },
};

const remoteWorkspace = {
    id: 'ws-gcp',
    dataPlaneId: '69a1dab5bd21ec33047a35cb',
    configTemplate: {
        hardwareTier: { id: { value: 'GCP-Small' }, name: 'GCP-Small', dataPlane: { id: '69a1dab5bd21ec33047a35cb', name: 'GCP' } },
        dataPlane: { host: 'gcp.domino.example.com' },
    },
};

describe('getWorkspaceDataPlane', () => {
    it('extracts id, name and host for a remote workspace', () => {
        expect(getWorkspaceDataPlane(remoteWorkspace)).toEqual({
            id: '69a1dab5bd21ec33047a35cb',
            name: 'GCP',
            host: 'gcp.domino.example.com',
        });
    });

    it('extracts the local data plane', () => {
        expect(getWorkspaceDataPlane(localWorkspace)).toEqual({
            id: LOCAL_DATA_PLANE_ID,
            name: 'Local',
            host: 'domino.example.com',
        });
    });

    it('falls back to mostRecentSession.config when configTemplate is missing', () => {
        const ws = { mostRecentSession: { config: remoteWorkspace.configTemplate } };
        expect(getWorkspaceDataPlane(ws)).toEqual({
            id: '69a1dab5bd21ec33047a35cb',
            name: 'GCP',
            host: 'gcp.domino.example.com',
        });
    });

    it('returns empty fields for workspaces without data plane info', () => {
        expect(getWorkspaceDataPlane({ id: 'ws-old' })).toEqual({ id: undefined, name: undefined, host: undefined });
        expect(getWorkspaceDataPlane(undefined)).toEqual({ id: undefined, name: undefined, host: undefined });
    });

    it('treats an empty host as missing', () => {
        const ws = { configTemplate: { dataPlane: { host: '' } } };
        expect(getWorkspaceDataPlane(ws).host).toBeUndefined();
    });
});

describe('getRemoteDataPlaneHost', () => {
    it('returns the host for a remote data plane', () => {
        expect(getRemoteDataPlaneHost({ host: 'gcp.domino.example.com' }, API_URL)).toBe('gcp.domino.example.com');
    });

    it('returns undefined when the host is the control plane host', () => {
        expect(getRemoteDataPlaneHost({ host: 'domino.example.com' }, API_URL)).toBeUndefined();
    });

    it('compares hosts case-insensitively and ignores scheme, port and trailing slash', () => {
        expect(getRemoteDataPlaneHost({ host: 'Domino.Example.com' }, 'https://domino.example.com/')).toBeUndefined();
        expect(getRemoteDataPlaneHost({ host: 'https://gcp.domino.example.com/' }, API_URL)).toBe('gcp.domino.example.com');
        expect(getRemoteDataPlaneHost({ host: 'gcp.domino.example.com' }, 'https://domino.example.com:443')).toBe('gcp.domino.example.com');
    });

    it('returns undefined when no host is known', () => {
        expect(getRemoteDataPlaneHost({ id: '69a1dab5bd21ec33047a35cb' }, API_URL)).toBeUndefined();
        expect(getRemoteDataPlaneHost({}, API_URL)).toBeUndefined();
    });
});

describe('isRemoteDataPlane', () => {
    it('uses the data plane id when present', () => {
        expect(isRemoteDataPlane({ id: LOCAL_DATA_PLANE_ID, host: 'domino.example.com' }, API_URL)).toBe(false);
        expect(isRemoteDataPlane({ id: '69a1996e4c40f92d06ce019d' }, API_URL)).toBe(true);
    });

    it('falls back to comparing hosts when the id is missing', () => {
        expect(isRemoteDataPlane({ host: 'azure.domino.example.com' }, API_URL)).toBe(true);
        expect(isRemoteDataPlane({ host: 'domino.example.com' }, API_URL)).toBe(false);
        expect(isRemoteDataPlane({}, API_URL)).toBe(false);
    });
});

describe('buildDomConnectArgs', () => {
    it('builds the local data plane command unchanged', () => {
        expect(buildDomConnectArgs('ws-1', API_URL, 'ubuntu')).toEqual([
            'connect', 'ws-1', '--domino-api-host=https://domino.example.com', '-l', 'ubuntu',
        ]);
    });

    it('adds --data-plane for a remote data plane', () => {
        expect(buildDomConnectArgs('ws-1', API_URL, 'domino', 'gcp.domino.example.com')).toEqual([
            'connect', 'ws-1', '--domino-api-host=https://domino.example.com', '--data-plane=gcp.domino.example.com', '-l', 'domino',
        ]);
    });
});

describe('formatTierDataPlane', () => {
    it('is empty for local or unknown data planes', () => {
        expect(formatTierDataPlane({ dataPlaneId: LOCAL_DATA_PLANE_ID, dataPlaneName: 'Local' })).toBe('');
        expect(formatTierDataPlane({})).toBe('');
    });

    it('names the remote data plane', () => {
        expect(formatTierDataPlane({ dataPlaneId: '69a1dab5bd21ec33047a35cb', dataPlaneName: 'GCP' })).toBe('Data plane: GCP');
    });

    it('falls back to the id when the name is missing', () => {
        expect(formatTierDataPlane({ dataPlaneId: '69a1dab5bd21ec33047a35cb' })).toBe('Data plane: 69a1dab5bd21ec33047a35cb');
    });
});
