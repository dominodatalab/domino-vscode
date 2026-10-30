// Helpers for Domino data planes (Hybrid/Nexus). Workspaces may run in the local data plane
// (same cluster as the control plane) or in a remote data plane with its own hostname.
// SSH to a remote data plane goes through the domino-connect service on that data plane,
// so `dom connect` must be given `--data-plane=<host>`.

export const LOCAL_DATA_PLANE_ID = '000000000000000000000000';

export interface DataPlaneInfo {
    id?: string;
    name?: string;
    host?: string;
}

// Extract data plane info from a workspace returned by /workspace/project/{projectId}/workspace
export function getWorkspaceDataPlane(workspace: any): DataPlaneInfo {
    const config = workspace?.configTemplate ?? workspace?.mostRecentSession?.config ?? {};
    const tierDataPlane = config.hardwareTier?.dataPlane ?? {};
    return {
        id: workspace?.dataPlaneId ?? tierDataPlane.id,
        name: tierDataPlane.name,
        host: config.dataPlane?.host || undefined,
    };
}

function hostnameOf(urlOrHost: string): string {
    try {
        return new URL(urlOrHost).hostname.toLowerCase();
    } catch {
        return urlOrHost.replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0].toLowerCase();
    }
}

// Returns the data plane host to pass to `dom connect --data-plane`, or undefined when the
// workspace runs in the local data plane (dom connect then defaults to the control plane).
export function getRemoteDataPlaneHost(dataPlane: DataPlaneInfo, apiUrl: string): string | undefined {
    if (!dataPlane.host) {
        return undefined;
    }
    const host = hostnameOf(dataPlane.host);
    if (!host || host === hostnameOf(apiUrl)) {
        return undefined;
    }
    return host;
}

export function isRemoteDataPlane(dataPlane: DataPlaneInfo, apiUrl: string): boolean {
    if (dataPlane.id) {
        return dataPlane.id !== LOCAL_DATA_PLANE_ID;
    }
    return getRemoteDataPlaneHost(dataPlane, apiUrl) !== undefined;
}

export function buildDomConnectArgs(
    workspaceId: string,
    apiUrl: string,
    sshUser: string,
    dataPlaneHost?: string
): string[] {
    const args = ['connect', workspaceId, `--domino-api-host=${apiUrl}`];
    if (dataPlaneHost) {
        args.push(`--data-plane=${dataPlaneHost}`);
    }
    args.push('-l', sshUser);
    return args;
}

// Short label for a hardware tier's data plane, empty for the local data plane
export function formatTierDataPlane(tier: { dataPlaneId?: string; dataPlaneName?: string }): string {
    if (!tier.dataPlaneId || tier.dataPlaneId === LOCAL_DATA_PLANE_ID) {
        return '';
    }
    return `Data plane: ${tier.dataPlaneName || tier.dataPlaneId}`;
}
