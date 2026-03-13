import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { DominoApiClient } from './dominoApiClient';
import { ProjectProvider } from './projectProvider';
import { JobProvider } from './jobProvider';
import { WorkspaceProvider } from './workspaceProvider';
import {
    TokenSet,
    performOAuthFlow,
    refreshAccessToken,
    revokeTokens,
    storeTokens,
    loadTokens,
    clearTokens,
} from './auth';

// SSH tunnel tracking
interface SshTunnel {
    terminal?: vscode.Terminal;  // undefined when isBackground is true
    port: number;
    workspaceId: string;
    workspaceName: string;
    isBackground: boolean;
    pid?: number;               // process PID when isBackground is true
}

const activeTunnels: Map<string, SshTunnel> = new Map();

// Check if process is still running
function isProcessRunning(pid: number | undefined): boolean {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return false;
    }
}

// --- SSH Tunnel Utilities ---

function isDomCliInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
        child_process.exec('dom --version', (error) => {
            resolve(!error);
        });
    });
}

function sanitizeHostname(name: string): string {
    return 'domino-' + name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

const SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');
const DOMINO_SSH_CONFIG_PATH = path.join(os.homedir(), '.domino', 'ssh', 'config');

function readPortFromDominoSshConfig(workspaceId: string): number | null {
    if (!fs.existsSync(DOMINO_SSH_CONFIG_PATH)) {
        return null;
    }
    const content = fs.readFileSync(DOMINO_SSH_CONFIG_PATH, 'utf-8');
    const lines = content.split('\n');
    let inHostBlock = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === `Host ${workspaceId}`) {
            inHostBlock = true;
            continue;
        }
        if (inHostBlock) {
            if (trimmed.startsWith('Host ')) {
                break;
            }
            const portMatch = trimmed.match(/^Port\s+(\d+)$/i);
            if (portMatch) {
                return parseInt(portMatch[1], 10);
            }
        }
    }
    return null;
}

function waitForDominoSshConfig(workspaceId: string, timeoutMs = 30000): Promise<number> {
    // Capture any pre-existing port so we can detect when dom connect writes a fresh one
    const stalePort = readPortFromDominoSshConfig(workspaceId);
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const poll = () => {
            const port = readPortFromDominoSshConfig(workspaceId);
            if (port !== null && port !== stalePort) {
                resolve(port);
                return;
            }
            if (Date.now() - startTime >= timeoutMs) {
                // If there's still a stale entry, use it as a last resort (proxy may still be running)
                if (stalePort !== null) {
                    resolve(stalePort);
                } else {
                    reject(new Error(`Timed out waiting for SSH tunnel to be established for workspace ${workspaceId}`));
                }
                return;
            }
            setTimeout(poll, 500);
        };
        poll();
    });
}

function addSshConfigEntry(workspaceId: string, workspaceName: string, port: number): void {
    const marker = `domino-vscode-extension:${workspaceId}`;
    const hostName = sanitizeHostname(workspaceName);
    const entry = [
        `# ${marker}`,
        `Host ${hostName}`,
        `    HostName localhost`,
        `    Port ${port}`,
        `    User ubuntu`,
        `    StrictHostKeyChecking no`,
        `    UserKnownHostsFile /dev/null`,
        `# ${marker}:end`,
        ''
    ].join('\n');

    // Ensure ~/.ssh directory exists
    const sshDir = path.dirname(SSH_CONFIG_PATH);
    if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
    }

    // Remove any existing entry for this workspace first
    removeSshConfigEntry(workspaceId);

    // Append the new entry
    const existing = fs.existsSync(SSH_CONFIG_PATH) ? fs.readFileSync(SSH_CONFIG_PATH, 'utf-8') : '';
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(SSH_CONFIG_PATH, existing + separator + entry, 'utf-8');
}

function removeSshConfigEntry(workspaceId: string): void {
    if (!fs.existsSync(SSH_CONFIG_PATH)) {
        return;
    }

    const content = fs.readFileSync(SSH_CONFIG_PATH, 'utf-8');
    const marker = `domino-vscode-extension:${workspaceId}`;
    const startMarker = `# ${marker}`;
    const endMarker = `# ${marker}:end`;

    const lines = content.split('\n');
    const filteredLines: string[] = [];
    let inside = false;

    for (const line of lines) {
        if (line.trim() === startMarker) {
            inside = true;
            continue;
        }
        if (line.trim() === endMarker) {
            inside = false;
            continue;
        }
        if (!inside) {
            filteredLines.push(line);
        }
    }

    fs.writeFileSync(SSH_CONFIG_PATH, filteredLines.join('\n'), 'utf-8');
}

function cleanupAllSshConfigEntries(): void {
    if (!fs.existsSync(SSH_CONFIG_PATH)) {
        return;
    }

    const content = fs.readFileSync(SSH_CONFIG_PATH, 'utf-8');
    const lines = content.split('\n');
    const filteredLines: string[] = [];
    let inside = false;

    for (const line of lines) {
        if (line.trim().startsWith('# domino-vscode-extension:') && !line.trim().endsWith(':end')) {
            inside = true;
            continue;
        }
        if (line.trim().startsWith('# domino-vscode-extension:') && line.trim().endsWith(':end')) {
            inside = false;
            continue;
        }
        if (!inside) {
            filteredLines.push(line);
        }
    }

    fs.writeFileSync(SSH_CONFIG_PATH, filteredLines.join('\n'), 'utf-8');
}

// --- Background tunnel state persistence ---

const TUNNEL_STATE_PATH = path.join(os.homedir(), '.domino', 'vscode-extension', 'tunnels.json');

interface PersistedTunnel {
    workspaceId: string;
    workspaceName: string;
    pid: number;
    port: number;
}

function loadPersistedTunnelStates(): PersistedTunnel[] {
    if (!fs.existsSync(TUNNEL_STATE_PATH)) { return []; }
    try {
        return JSON.parse(fs.readFileSync(TUNNEL_STATE_PATH, 'utf-8'));
    } catch {
        return [];
    }
}

function saveBackgroundTunnelState(tunnel: SshTunnel): void {
    const dir = path.dirname(TUNNEL_STATE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    let state = loadPersistedTunnelStates().filter(t => t.workspaceId !== tunnel.workspaceId);
    state.push({ workspaceId: tunnel.workspaceId, workspaceName: tunnel.workspaceName, pid: tunnel.pid!, port: tunnel.port });
    fs.writeFileSync(TUNNEL_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

function removeBackgroundTunnelState(workspaceId: string): void {
    if (!fs.existsSync(TUNNEL_STATE_PATH)) { return; }
    try {
        const state = loadPersistedTunnelStates().filter(t => t.workspaceId !== workspaceId);
        fs.writeFileSync(TUNNEL_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch { /* ignore */ }
}

function restoreBackgroundTunnels(): void {
    const states = loadPersistedTunnelStates();
    const alive: PersistedTunnel[] = [];

    for (const state of states) {
        if (isProcessRunning(state.pid)) {
            const tunnel: SshTunnel = {
                port: state.port,
                workspaceId: state.workspaceId,
                workspaceName: state.workspaceName,
                pid: state.pid,
                isBackground: true,
            };
            activeTunnels.set(state.workspaceId, tunnel);
            // Ensure the SSH config entry is still present so Remote-SSH can connect
            addSshConfigEntry(state.workspaceId, state.workspaceName, state.port);
            alive.push(state);
        }
        // Dead processes are simply dropped; their SSH config entries will have been
        // cleaned up on their next reconnect attempt or by the user explicitly.
    }

    // Rewrite the state file with only the live processes
    const dir = path.dirname(TUNNEL_STATE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(TUNNEL_STATE_PATH, JSON.stringify(alive, null, 2), 'utf-8');

    if (alive.length > 0) {
        workspaceProvider.refresh();
    }
}

// --- SSH Tunnel Commands ---

async function connectSSH(workspaceItem?: any) {
    try {
        if (!workspaceItem || !workspaceItem.workspaceId) {
            vscode.window.showWarningMessage('Please select a running workspace to connect via SSH');
            return;
        }

        const workspaceId: string = workspaceItem.workspaceId;
        const workspaceName: string = workspaceItem.label || workspaceId;

        // Check for existing tunnel
        if (activeTunnels.has(workspaceId)) {
            const existing = activeTunnels.get(workspaceId)!;
            const action = await vscode.window.showInformationMessage(
                `SSH tunnel already active for "${workspaceName}" on port ${existing.port}`,
                'Open Remote-SSH',
                'Show Details'
            );
            if (action === 'Open Remote-SSH') {
                await openRemoteSshWindow(workspaceId, existing.port);
            } else if (action === 'Show Details') {
                showTunnelDetails(workspaceId, existing.port);
            }
            return;
        }

        // Verify dom CLI is installed
        const domInstalled = await isDomCliInstalled();
        if (!domInstalled) {
            vscode.window.showErrorMessage(
                'The `dom` CLI is not installed or not in your PATH. Please install it to use SSH tunnels.',
                'Learn More'
            ).then(action => {
                if (action === 'Learn More') {
                    vscode.env.openExternal(vscode.Uri.parse('https://docs.dominodatalab.com/en/latest/user_guide/domino_cli.html'));
                }
            });
            return;
        }

        // Get API host and find available port
        const apiUrl = dominoClient.apiUrl;
        if (!apiUrl) {
            vscode.window.showErrorMessage('Domino API URL not configured. Please authenticate first.');
            return;
        }

        // Check which proxy mode the user wants
        const config = vscode.workspace.getConfiguration('domino');
        const backgroundMode = config.get<boolean>('sshBackgroundProxy', false);

        const domArgs = ['connect', workspaceId, `--domino-api-host=${apiUrl}`, '-l', 'ubuntu'];
        let port: number;

        if (backgroundMode) {
            // --- Background mode: spawn a detached process that survives VSCode ---
            const logDir = path.join(os.homedir(), '.domino', 'vscode-extension', 'logs');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
            }
            const logFile = path.join(logDir, `${workspaceId}.log`);
            const logFd = fs.openSync(logFile, 'a');

            console.log(`Spawning background process: dom ${domArgs.join(' ')}`);
            const proc = child_process.spawn('dom', domArgs, {
                detached: true,
                stdio: ['ignore', logFd, logFd],
            });
            proc.unref(); // Allow VSCode to exit without killing this process
            fs.closeSync(logFd);

            // Wait for dom connect to write the dynamically assigned port to ~/.domino/ssh/config
            try {
                port = await waitForDominoSshConfig(workspaceId);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to establish SSH tunnel for "${workspaceName}": timed out waiting for dom connect to start`);
                try { process.kill(proc.pid!, 'SIGTERM'); } catch { /* already dead */ }
                return;
            }

            const tunnel: SshTunnel = { port, workspaceId, workspaceName, pid: proc.pid, isBackground: true };
            activeTunnels.set(workspaceId, tunnel);
            addSshConfigEntry(workspaceId, workspaceName, port);
            saveBackgroundTunnelState(tunnel);
            workspaceProvider.refresh();

        } else {
            // --- Terminal mode: run dom connect in a visible VSCode terminal (default) ---
            const command = `dom connect ${workspaceId} --domino-api-host=${apiUrl} -l ubuntu`;
            console.log(`Running in terminal: ${command}`);

            const terminal = vscode.window.createTerminal({ name: `SSH: ${workspaceName}` });
            terminal.show();
            terminal.sendText(command);

            // Wait for dom connect to write the dynamically assigned port to ~/.domino/ssh/config
            try {
                port = await waitForDominoSshConfig(workspaceId);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to establish SSH tunnel for "${workspaceName}": timed out waiting for dom connect to start`);
                terminal.dispose();
                return;
            }

            const tunnel: SshTunnel = { terminal, port, workspaceId, workspaceName, isBackground: false };
            activeTunnels.set(workspaceId, tunnel);
            addSshConfigEntry(workspaceId, workspaceName, port);
            workspaceProvider.refresh();
        }

        const sshHost = sanitizeHostname(workspaceName);

        // Check auto-connect setting
        const autoConnect = config.get<boolean>('sshAutoConnect', true);

        if (autoConnect) {
            openRemoteSshWindow(sshHost, port);
        } else {
            vscode.window.showInformationMessage(
                `SSH tunnel to "${workspaceName}" established on port ${port}`,
                'Connect Remote-SSH',
                'Copy SSH Command'
            ).then(action => {
                if (action === 'Connect Remote-SSH') {
                    openRemoteSshWindow(sshHost, port);
                } else if (action === 'Copy SSH Command') {
                    vscode.env.clipboard.writeText(`ssh -p ${port} ubuntu@localhost`);
                    vscode.window.showInformationMessage('SSH command copied to clipboard');
                }
            });
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to connect SSH tunnel: ${error}`);
    }
}

async function openRemoteSshWindow(hostName: string, port: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('domino');
    const defaultDir = config.get<string>('workspaceDefaultDirectory', '/mnt');
    const remoteUri = vscode.Uri.parse(`vscode-remote://ssh-remote+${hostName}${defaultDir}`);

    try {
        // Primary: open a new window connected to the remote host
        await vscode.commands.executeCommand('vscode.openFolder', remoteUri, { forceNewWindow: true });
        return;
    } catch (err) {
        console.log('vscode.openFolder with remote URI failed, trying fallback:', err);
    }

    try {
        // Fallback: use the Remote-SSH extension command
        await vscode.commands.executeCommand('opensshremote.openEmptyWindow', {
            host: hostName
        });
        return;
    } catch (err) {
        console.log('opensshremote.openEmptyWindow failed, offering to install:', err);
    }

    // Both failed — offer to install Remote-SSH
    const action = await vscode.window.showWarningMessage(
        'Could not open Remote-SSH window. Is the Remote-SSH extension installed?',
        'Install Remote-SSH',
        'Copy SSH Command'
    );

    if (action === 'Install Remote-SSH') {
        vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            'ms-vscode-remote.remote-ssh'
        );
    } else if (action === 'Copy SSH Command') {
        vscode.env.clipboard.writeText(`ssh -p ${port} ubuntu@localhost`);
        vscode.window.showInformationMessage('SSH command copied to clipboard');
    }
}

function showTunnelDetails(workspaceId: string, port: number): void {
    const sshCommand = `ssh -p ${port} ubuntu@localhost`;
    vscode.window.showInformationMessage(
        `SSH Tunnel — Port: ${port} | Host: ${workspaceId}`,
        'Copy SSH Command',
        'Open Remote-SSH'
    ).then(action => {
        if (action === 'Copy SSH Command') {
            vscode.env.clipboard.writeText(sshCommand);
            vscode.window.showInformationMessage('SSH command copied to clipboard');
        } else if (action === 'Open Remote-SSH') {
            openRemoteSshWindow(workspaceId, port);
        }
    });
}

async function disconnectSSH(workspaceItem?: any) {
    try {
        if (!workspaceItem || !workspaceItem.workspaceId) {
            vscode.window.showWarningMessage('Please select a workspace to disconnect SSH');
            return;
        }

        const workspaceId: string = workspaceItem.workspaceId;
        const tunnel = activeTunnels.get(workspaceId);

        if (!tunnel) {
            vscode.window.showInformationMessage('No active SSH tunnel for this workspace');
            return;
        }

        // Stop the proxy process
        if (tunnel.isBackground) {
            if (tunnel.pid) {
                try { process.kill(tunnel.pid, 'SIGTERM'); } catch { /* already dead */ }
            }
            removeBackgroundTunnelState(workspaceId);
        } else {
            tunnel.terminal!.dispose();
        }
        activeTunnels.delete(workspaceId);
        removeSshConfigEntry(workspaceId);
        workspaceProvider.refresh();

        vscode.window.showInformationMessage(
            `SSH tunnel to "${tunnel.workspaceName}" disconnected`
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to disconnect SSH tunnel: ${error}`);
    }
}

async function disableAutoRefresh() {
    if (isAutoRefreshEnabled) {
        isAutoRefreshEnabled = false;
        stopAutoRefresh();
        vscode.window.showInformationMessage('Auto-refresh disabled');
        
        const config = vscode.workspace.getConfiguration('domino');
        await config.update('autoRefreshEnabled', false, vscode.ConfigurationTarget.Global);
    }
}

async function authenticate() {
    try {
        const config = vscode.workspace.getConfiguration('domino');
        let apiUrl = (config.get<string>('apiUrl') || '').trim().replace(/\/$/, '');
        const clientId = config.get<string>('oauthClientId', 'domino-connect-client');

        // If no URL is pre-configured, prompt the user once
        if (!apiUrl) {
            const entered = await vscode.window.showInputBox({
                prompt: 'Enter your Domino URL',
                placeHolder: 'https://your-domino-instance.com',
                validateInput: (value) => {
                    if (!value || !value.startsWith('https://')) {
                        return 'Please enter a valid HTTPS URL';
                    }
                    return null;
                }
            });
            if (!entered) {
                return;
            }
            apiUrl = entered.trim().replace(/\/$/, '');
            await config.update('apiUrl', apiUrl, vscode.ConfigurationTarget.Global);
        }

        const tokens = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Opening browser for Domino authentication...',
            cancellable: false,
        }, () => performOAuthFlow(apiUrl, clientId));

        await storeTokens(secretStorage, tokens);
        await dominoClient.authenticate(apiUrl, tokens.accessToken);
        scheduleTokenRefresh(tokens);

        vscode.commands.executeCommand('setContext', 'domino:authenticated', true);
        vscode.window.showInformationMessage('Successfully authenticated with Domino!');

        // Fetch current user for status bar display
        try {
            const self = await dominoClient.getSelf();
            currentUserName = self.userName || '';
        } catch { /* non-critical */ }
        updateStatusBar();

        projectProvider.refresh();
        jobProvider.refresh();
        workspaceProvider.refresh();
        startAutoRefresh();

    } catch (error) {
        vscode.window.showErrorMessage(`Authentication failed: ${error}`);
    }
}

async function signOut() {
    try {
        if (tokenRefreshTimer) {
            clearTimeout(tokenRefreshTimer);
            tokenRefreshTimer = undefined;
        }

        const tokens = await loadTokens(secretStorage);
        if (tokens) {
            const config = vscode.workspace.getConfiguration('domino');
            const clientId = config.get<string>('oauthClientId', 'domino-connect-client');
            await revokeTokens(tokens, clientId);
        }

        await clearTokens(secretStorage);
        dominoClient.clearAuth();
        stopAutoRefresh();

        vscode.commands.executeCommand('setContext', 'domino:authenticated', false);
        currentUserName = '';
        updateStatusBar();

        projectProvider.refresh();
        jobProvider.refresh();
        workspaceProvider.refresh();

        vscode.window.showInformationMessage('Signed out of Domino.');
    } catch (error) {
        vscode.window.showErrorMessage(`Sign out failed: ${error}`);
    }
}

async function selectProject(projectItem?: any) {
    try {
        // If called from tree view with a project item, use it directly
        if (projectItem && projectItem.projectId && projectItem.label) {
            console.log('Selecting project from tree view:', projectItem.label);
            await dominoClient.setCurrentProject(projectItem.projectId, projectItem.label, projectItem.ownerUsername);
            vscode.window.showInformationMessage(`Selected project: ${projectItem.label}`);
            
            // Update status bar
            updateStatusBar();

            // Refresh all views
            console.log('Refreshing all views after project selection');
            jobProvider.refresh();
            workspaceProvider.refresh();

            // Restart auto-refresh for the new project
            if (isAutoRefreshEnabled) {
                startAutoRefresh();
            }
            return;
        }

        // Get projects list
        const projects = await dominoClient.getProjects();
        
        // If no projects available
        if (projects.length === 0) {
            vscode.window.showWarningMessage('No projects available. Create a project first.');
            return;
        }
        
        // If only one project, select it automatically
        if (projects.length === 1) {
            const project = projects[0];
            console.log('Only one project available, auto-selecting:', project.name);
            
            await dominoClient.setCurrentProject(project.id, project.name, project.ownerUsername);
            vscode.window.showInformationMessage(`Auto-selected project: ${project.name}`);
            
            // Update status bar
            updateStatusBar();

            // Refresh all views
            console.log('Refreshing all views after auto project selection');
            jobProvider.refresh();
            workspaceProvider.refresh();

            // Start auto-refresh for the selected project
            if (isAutoRefreshEnabled) {
                startAutoRefresh();
            }
            return;
        }
        
        // Multiple projects available - show the picker
        const projectOptions = projects.map(project => ({
            label: project.name,
            description: project.description,
            detail: `Owner: ${project.ownerUsername}`,
            project: project
        }));

        const selected = await vscode.window.showQuickPick(projectOptions, {
            placeHolder: `Select a Domino project (${projects.length} available)`
        });

        if (selected) {
            await dominoClient.setCurrentProject(selected.project.id, selected.project.name, selected.project.ownerUsername);
            vscode.window.showInformationMessage(`Selected project: ${selected.project.name}`);
            
            // Update status bar
            updateStatusBar();
            
            // Manually refresh all views to ensure they update
            console.log('Refreshing all views after project selection');
            jobProvider.refresh();
            workspaceProvider.refresh();

            // Restart auto-refresh for the new project
            if (isAutoRefreshEnabled) {
                startAutoRefresh();
            }
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to select project: ${error}`);
    }
}

async function createProject() {
    try {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter project name',
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Project name is required';
                }
                return null;
            }
        });

        if (!name) {
            return;
        }

        const description = await vscode.window.showInputBox({
            prompt: 'Enter project description (optional)'
        });

        const project = await dominoClient.createProject(name, description);
        vscode.window.showInformationMessage(`Created project: ${project.name}`);
        
        projectProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create project: ${error}`);
    }
}

async function runJob(prefilledCommand?: string, prefilledTitle?: string) {
    try {
        if (!dominoClient.currentProjectId) {
            vscode.window.showWarningMessage('Please select a project first');
            return;
        }

        // Get command from user
        const command = await vscode.window.showInputBox({
            prompt: 'Enter command to run',
            placeHolder: 'python main.py',
            value: prefilledCommand,
            validateInput: (value: string) => {
                if (!value || value.trim().length === 0) {
                    return 'Command is required';
                }
                return null;
            }
        });

        if (!command) {
            return;
        }

        // Get job title
        const title = await vscode.window.showInputBox({
            prompt: 'Enter job title (optional)',
            placeHolder: 'My Job from VS Code',
            value: prefilledTitle,
        });

        // Show progress while getting configuration options
        const configOptions = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Loading configuration options...',
            cancellable: false
        }, async () => {
            try {
                // Try to get both options and project settings
                const [hardwareTiers, environments, projectSettings] = await Promise.all([
                    dominoClient.getHardwareTiers().catch(error => {
                        console.warn('Failed to get hardware tiers:', error);
                        return [];
                    }),
                    dominoClient.getEnvironments().catch(error => {
                        console.warn('Failed to get environments:', error);
                        return [];
                    }),
                    dominoClient.getProjectSettings().catch(error => {
                        console.warn('Failed to get project settings:', error);
                        return null;
                    })
                ]);
                
                return { hardwareTiers, environments, projectSettings };
            } catch (error) {
                console.warn('Could not load configuration options:', error);
                return { hardwareTiers: [], environments: [], projectSettings: null };
            }
        });

        // Let user select hardware tier - always show if we have any options
        let selectedHardwareTier: string | undefined;
        if (configOptions.hardwareTiers.length > 0) {
            const hardwareTierOptions = configOptions.hardwareTiers.map((tier: any) => {
                // Create a detailed description showing CPU, memory, and GPU info
                const details = [];
                if (tier.cpu !== 'N/A') {
                    details.push(`${tier.cpu} CPU${tier.cpu !== '1' ? 's' : ''}`);
                }
                if (tier.memory !== 'N/A') {
                    details.push(`${tier.memory} ${tier.memoryUnit || 'GiB'} RAM`);
                }
                if (tier.gpus && tier.gpus > 0) {
                    details.push(`${tier.gpus} GPU${tier.gpus !== 1 ? 's' : ''}`);
                }
                
                const description = details.length > 0 ? details.join(', ') : tier.description || '';
                const isDefault = tier.id === configOptions.projectSettings?.defaultHardwareTierId;
                
                return {
                    label: `${tier.name}${isDefault ? ' (default)' : ''}`,
                    description: description,
                    detail: `ID: ${tier.id}`,
                    value: tier.id
                };
            });

            // Pre-select the default if available
            const defaultIndex = hardwareTierOptions.findIndex(option => 
                option.value === configOptions.projectSettings?.defaultHardwareTierId
            );

            const selectedTier = await vscode.window.showQuickPick(hardwareTierOptions, {
                placeHolder: 'Select hardware tier (or press Escape to use project default)',
                canPickMany: false,
                ...(defaultIndex >= 0 && { activeItem: hardwareTierOptions[defaultIndex] })
            });

            selectedHardwareTier = selectedTier?.value;
        } else {
            // Show info that no options are available
            vscode.window.showInformationMessage('No hardware tiers available - using project default');
        }

        // Let user select environment - always show if we have any options
        let selectedEnvironment: string | undefined;
        if (configOptions.environments.length > 0) {
            const environmentOptions = configOptions.environments.map((env: any) => {
                // Create a detailed description
                const details = [];
                if (env.version && env.version !== 'N/A') {
                    details.push(`v${env.version}`);
                }
                if (env.visibility) {
                    details.push(env.visibility);
                }
                if (env.isCurated) {
                    details.push('Curated');
                }
                
                const description = details.length > 0 ? details.join(', ') : env.description || '';
                
                return {
                    label: `${env.name}${env.isDefault ? ' (default)' : ''}`,
                    description: description,
                    detail: `ID: ${env.id}`,
                    value: env.id
                };
            });

            // Pre-select the default environment (the currently selected one)
            const defaultIndex = environmentOptions.findIndex(option => 
                configOptions.environments.find((env: any) => env.id === option.value && env.isDefault)
            );

            const selectedEnv = await vscode.window.showQuickPick(environmentOptions, {
                placeHolder: 'Select compute environment (or press Escape to use project default)',
                canPickMany: false,
                ...(defaultIndex >= 0 && { activeItem: environmentOptions[defaultIndex] })
            });

            selectedEnvironment = selectedEnv?.value;
        } else {
            // Show info that no options are available
            vscode.window.showInformationMessage('No compute environments available - using project default');
        }

        // Show what defaults will be used if user didn't select anything
        if (!selectedHardwareTier && !selectedEnvironment) {
            const defaultsInfo = [];
            if (configOptions.projectSettings?.defaultHardwareTierId) {
                defaultsInfo.push(`Hardware: ${configOptions.projectSettings.defaultHardwareTierId}`);
            }
            if (configOptions.projectSettings?.defaultEnvironmentId) {
                defaultsInfo.push(`Environment: ${configOptions.projectSettings.defaultEnvironmentId}`);
            }
            
            if (defaultsInfo.length > 0) {
                vscode.window.showInformationMessage(`Using project defaults: ${defaultsInfo.join(', ')}`);
            }
        }

        // Run the job
        const job = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Starting job...',
            cancellable: false
        }, async () => {
            return await dominoClient.runJob(command.trim(), title?.trim(), {
                hardwareTierId: selectedHardwareTier,
                environmentId: selectedEnvironment
            });
        });

        // Show success message with job details
        const jobTitle = job.title || job.id || 'Unknown';
        const message = `Started job: ${jobTitle}`;
        
        vscode.window.showInformationMessage(message, 'View Jobs', 'Open in Domino')
            .then((selection: string | undefined) => {
                if (selection === 'View Jobs') {
                    jobProvider.refresh();
                    vscode.commands.executeCommand('dominoJobs.focus');
                } else if (selection === 'Open in Domino' && job.id) {
                    // Open job in browser if we have the job ID
                    const config = vscode.workspace.getConfiguration('domino');
                    const apiUrl = config.get<string>('apiUrl');
                    if (apiUrl && dominoClient.currentProjectName) {
                        const jobUrl = `${apiUrl}/jobs/${job.ownerUsername || 'unknown'}/${dominoClient.currentProjectName}/${job.id}/results`;
                        vscode.env.openExternal(vscode.Uri.parse(jobUrl));
                    }
                }
            });
        
        // Refresh job view to show the new job
        jobProvider.refresh();

    } catch (error) {
        console.error('Run job error:', error);
        vscode.window.showErrorMessage(`Failed to run job: ${error}`);
    }
}

async function runJobWithFile(fileUri?: vscode.Uri) {
    try {
        if (!dominoClient.currentProjectId) {
            vscode.window.showWarningMessage('Please select a project first');
            return;
        }

        // Get the file to run
        let targetFile: vscode.Uri | undefined = fileUri;
        
        if (!targetFile) {
            // If no file was passed (shouldn't happen with context menu), ask user to select
            const files = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Select File to Run',
                filters: {
                    'Runnable Files': ['py', 'r', 'R', 'js', 'ts', 'sh', 'scala', 'java', 'sql'],
                    'Notebooks': ['ipynb'],
                    'All Files': ['*']
                }
            });
            
            if (!files || files.length === 0) {
                return;
            }
            targetFile = files[0];
        }

        // Get the relative path from workspace
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetFile);
        if (!workspaceFolder) {
            vscode.window.showWarningMessage('File must be within a workspace folder');
            return;
        }

        const relativePath = vscode.workspace.asRelativePath(targetFile, false);
        const fileName = targetFile.path.split('/').pop() || relativePath;
        const fileExtension = fileName.split('.').pop()?.toLowerCase();

        // Generate appropriate command based on file type
        let suggestedCommand = generateCommandForFile(relativePath, fileExtension);
        
        // Let user confirm/modify the command
        const command = await vscode.window.showInputBox({
            prompt: `Enter command to run ${fileName}`,
            value: suggestedCommand,
            validateInput: (value: string) => {
                if (!value || value.trim().length === 0) {
                    return 'Command is required';
                }
                return null;
            }
        });

        if (!command) {
            return;
        }

        // Generate job title
        const defaultTitle = `Run ${fileName} from VS Code`;
        const title = await vscode.window.showInputBox({
            prompt: 'Enter job title (optional)',
            value: defaultTitle,
            placeHolder: defaultTitle
        });

        // Show progress while getting configuration options
        const configOptions = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Loading configuration options...',
            cancellable: false
        }, async () => {
            try {
                const [hardwareTiers, environments, projectSettings] = await Promise.all([
                    dominoClient.getHardwareTiers().catch(error => {
                        console.warn('Failed to get hardware tiers:', error);
                        return [];
                    }),
                    dominoClient.getEnvironments().catch(error => {
                        console.warn('Failed to get environments:', error);
                        return [];
                    }),
                    dominoClient.getProjectSettings().catch(error => {
                        console.warn('Failed to get project settings:', error);
                        return null;
                    })
                ]);
                
                return { hardwareTiers, environments, projectSettings };
            } catch (error) {
                console.warn('Could not load configuration options:', error);
                return { hardwareTiers: [], environments: [], projectSettings: null };
            }
        });

        // Let user select hardware tier if available
        let selectedHardwareTier: string | undefined;
        if (configOptions.hardwareTiers.length > 0) {
            const hardwareTierOptions = configOptions.hardwareTiers.map((tier: any) => {
                const details = [];
                if (tier.cpu !== 'N/A') {
                    details.push(`${tier.cpu} CPU${tier.cpu !== '1' ? 's' : ''}`);
                }
                if (tier.memory !== 'N/A') {
                    details.push(`${tier.memory} ${tier.memoryUnit || 'GiB'} RAM`);
                }
                if (tier.gpus && tier.gpus > 0) {
                    details.push(`${tier.gpus} GPU${tier.gpus !== 1 ? 's' : ''}`);
                }
                
                const description = details.length > 0 ? details.join(', ') : tier.description || '';
                const isDefault = tier.id === configOptions.projectSettings?.defaultHardwareTierId;
                
                return {
                    label: `${tier.name}${isDefault ? ' (default)' : ''}`,
                    description: description,
                    detail: `ID: ${tier.id}`,
                    value: tier.id
                };
            });

            const defaultIndex = hardwareTierOptions.findIndex(option => 
                option.value === configOptions.projectSettings?.defaultHardwareTierId
            );

            const selectedTier = await vscode.window.showQuickPick(hardwareTierOptions, {
                placeHolder: 'Select hardware tier (or press Escape to use project default)',
                canPickMany: false,
                ...(defaultIndex >= 0 && { activeItem: hardwareTierOptions[defaultIndex] })
            });

            selectedHardwareTier = selectedTier?.value;
        }

        // Let user select environment if available
        let selectedEnvironment: string | undefined;
        if (configOptions.environments.length > 0) {
            const environmentOptions = configOptions.environments.map((env: any) => {
                const details = [];
                if (env.version && env.version !== 'N/A') {
                    details.push(`v${env.version}`);
                }
                if (env.visibility) {
                    details.push(env.visibility);
                }
                if (env.isCurated) {
                    details.push('Curated');
                }
                
                const description = details.length > 0 ? details.join(', ') : env.description || '';
                
                return {
                    label: `${env.name}${env.isDefault ? ' (default)' : ''}`,
                    description: description,
                    detail: `ID: ${env.id}`,
                    value: env.id
                };
            });

            const defaultIndex = environmentOptions.findIndex(option => 
                configOptions.environments.find((env: any) => env.id === option.value && env.isDefault)
            );

            const selectedEnv = await vscode.window.showQuickPick(environmentOptions, {
                placeHolder: 'Select compute environment (or press Escape to use project default)',
                canPickMany: false,
                ...(defaultIndex >= 0 && { activeItem: environmentOptions[defaultIndex] })
            });

            selectedEnvironment = selectedEnv?.value;
        }

        // Run the job
        const job = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Starting job for ${fileName}...`,
            cancellable: false
        }, async () => {
            return await dominoClient.runJob(command.trim(), title?.trim() || defaultTitle, {
                hardwareTierId: selectedHardwareTier,
                environmentId: selectedEnvironment
            });
        });

        // Show success message with job details
        const jobTitle = job.title || job.id || 'Unknown';
        const message = `Started job "${jobTitle}" to run ${fileName}`;
        
        vscode.window.showInformationMessage(message, 'View Jobs', 'Open in Domino')
            .then((selection: string | undefined) => {
                if (selection === 'View Jobs') {
                    jobProvider.refresh();
                    vscode.commands.executeCommand('dominoJobs.focus');
                } else if (selection === 'Open in Domino' && job.id) {
                    const config = vscode.workspace.getConfiguration('domino');
                    const apiUrl = config.get<string>('apiUrl');
                    if (apiUrl && dominoClient.currentProjectName) {
                        const jobUrl = `${apiUrl}/jobs/${job.ownerUsername || 'unknown'}/${dominoClient.currentProjectName}/${job.id}/results`;
                        vscode.env.openExternal(vscode.Uri.parse(jobUrl));
                    }
                }
            });
        
        // Refresh job view to show the new job
        jobProvider.refresh();

    } catch (error) {
        console.error('Run job with file error:', error);
        vscode.window.showErrorMessage(`Failed to run job: ${error}`);
    }
}

function generateCommandForFile(filePath: string, extension?: string): string {
    const fileName = filePath.split('/').pop() || filePath;
    
    // Get user-configured defaults
    const config = vscode.workspace.getConfiguration('domino');
    const defaults = config.get('fileRunnerDefaults', {
        python: 'python "{file}"',
        r: 'Rscript "{file}"',
        javascript: 'node "{file}"',
        typescript: 'npx ts-node "{file}"',
        shell: 'bash "{file}"',
        notebook: 'jupyter nbconvert --execute --to notebook --inplace "{file}"'
    });
    
    // Replace {file} placeholder with actual file path
    const replaceFile = (template: string) => template.replace(/\{file\}/g, filePath);
    
    switch (extension) {
        case 'py':
            return replaceFile(defaults.python);
        case 'r':
        case 'R':
            return replaceFile(defaults.r);
        case 'js':
            return replaceFile(defaults.javascript);
        case 'ts':
            return replaceFile(defaults.typescript);
        case 'sh':
            return replaceFile(defaults.shell);
        case 'scala':
            return `scala "${filePath}"`;
        case 'java':
            const className = fileName.replace('.java', '');
            return `javac "${filePath}" && java ${className}`;
        case 'sql':
            return `# SQL files typically need a database connection\n# Example: psql -f "${filePath}"`;
        case 'ipynb':
            return replaceFile(defaults.notebook);
        default:
            // For unknown extensions, try to be smart about it
            if (filePath.includes('.')) {
                return `# Update this command for your file type\n./"${filePath}"`;
            } else {
                return `# Update this command for your file\n"${filePath}"`;
            }
    }
}

async function startWorkspace(workspaceItem?: any) {
    try {
        let workspaceId = workspaceItem?.workspaceId;
        
        if (!workspaceId) {
            vscode.window.showWarningMessage('Please select a workspace to start');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Starting workspace...',
            cancellable: false
        }, async () => {
            await dominoClient.startWorkspace(workspaceId);
            vscode.window.showInformationMessage('Workspace start request sent successfully');
        });

        workspaceProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to start workspace: ${error}`);
    }
}

async function stopWorkspace(workspaceItem?: any) {
    try {
        let workspaceId = workspaceItem?.workspaceId;
        
        if (!workspaceId) {
            vscode.window.showWarningMessage('Please select a workspace to stop');
            return;
        }

        const confirmStop = await vscode.window.showWarningMessage(
            'Are you sure you want to stop this workspace? Any unsaved work may be lost.',
            'Stop Workspace',
            'Cancel'
        );

        if (confirmStop !== 'Stop Workspace') {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Stopping workspace...',
            cancellable: false
        }, async () => {
            // Clean up any active SSH tunnel for this workspace
            const tunnel = activeTunnels.get(workspaceId);
            if (tunnel) {
                if (tunnel.isBackground) {
                    if (tunnel.pid) {
                        try { process.kill(tunnel.pid, 'SIGTERM'); } catch { /* already dead */ }
                    }
                    removeBackgroundTunnelState(workspaceId);
                } else {
                    tunnel.terminal!.dispose();
                }
                activeTunnels.delete(workspaceId);
                removeSshConfigEntry(workspaceId);
            }

            await dominoClient.stopWorkspace(workspaceId);
            vscode.window.showInformationMessage('Workspace stopped successfully');
        });

        workspaceProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to stop workspace: ${error}`);
    }
}

async function openWorkspace(workspaceItem?: any) {
    try {
        if (!workspaceItem) {
            vscode.window.showWarningMessage('Please select a workspace from the list');
            return;
        }

        if (!dominoClient.currentProjectName) {
            vscode.window.showWarningMessage('Project name not available');
            return;
        }

        // Get the workspace details to construct the proper URL
        const workspaces = await dominoClient.getWorkspaces();
        const workspace = workspaces.find(ws => ws.id === workspaceItem.workspaceId);
        
        if (!workspace) {
            vscode.window.showErrorMessage('Workspace not found');
            return;
        }

        if (workspace.state !== 'Started') {
            vscode.window.showWarningMessage('Workspace is not running');
            return;
        }

        // Extract required information for URL construction
        const username = workspace.ownerName;
        const projectName = dominoClient.currentProjectName;
        const workspaceId = workspace.id;
        const executionId = workspace.mostRecentSession?.executionId;
        const config = vscode.workspace.getConfiguration('domino');
        const apiUrl = config.get<string>('apiUrl') || '';
        let host: string;
        try {
            host = new URL(apiUrl).host;
        } catch {
            host = workspace.configTemplate?.dataPlane?.host || apiUrl;
        }

        if (!executionId) {
            vscode.window.showErrorMessage('Workspace execution ID not available');
            return;
        }

        // Construct the workspace URL
        const workspaceUrl = `https://${host}/workspace-session/${username}/${projectName}?owner=${username}&projectName=${projectName}&runId=${executionId}&workspaceId=${workspaceId}`;
        
        console.log('Opening workspace URL:', workspaceUrl);
        vscode.env.openExternal(vscode.Uri.parse(workspaceUrl));
        
    } catch (error) {
        console.error('Failed to open workspace:', error);
        vscode.window.showErrorMessage(`Failed to open workspace: ${error}`);
    }
}

async function commitWorkspace(workspaceItem?: any) {
    try {
        let workspaceId = workspaceItem?.workspaceId;
        
        if (!workspaceId) {
            vscode.window.showWarningMessage('Please select a workspace to commit');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Committing workspace changes...',
            cancellable: false
        }, async () => {
            const result = await dominoClient.commitWorkspace(workspaceId);
            
            // Show success message with details if available
            if (result && result.commitId) {
                vscode.window.showInformationMessage(
                    `Workspace committed successfully! Commit ID: ${result.commitId}`,
                    'View in Domino'
                ).then(selection => {
                    if (selection === 'View in Domino') {
                        // Could open commit details in browser if URL is available
                        vscode.window.showInformationMessage('Open your Domino project to view the commit details');
                    }
                });
            } else {
                vscode.window.showInformationMessage('Workspace changes committed successfully!');
            }
        });

        // Optionally refresh workspace view to show updated status
        workspaceProvider.refresh();
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to commit workspace: ${error}`);
    }
}

async function createNewWorkspace() {
    try {
        // Step 1: Validate project selected
        if (!dominoClient.currentProjectId) {
            vscode.window.showWarningMessage('Please select a project first.');
            return;
        }

        // Step 2: Enter workspace name
        const workspaceName = await vscode.window.showInputBox({
            prompt: 'Enter a name for the new workspace',
            placeHolder: 'My Workspace',
            validateInput: (value: string) => {
                if (!value || value.trim().length === 0) {
                    return 'Workspace name is required';
                }
                return null;
            }
        });

        if (!workspaceName) {
            return;
        }

        // Step 3: Load environments + hardware tiers in parallel
        const configOptions = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Loading configuration options...',
            cancellable: false
        }, async () => {
            try {
                const [hardwareTiers, environments, projectSettings] = await Promise.all([
                    dominoClient.getHardwareTiers().catch(error => {
                        console.warn('Failed to get hardware tiers:', error);
                        return [];
                    }),
                    dominoClient.getEnvironments().catch(error => {
                        console.warn('Failed to get environments:', error);
                        return [];
                    }),
                    dominoClient.getProjectSettings().catch(error => {
                        console.warn('Failed to get project settings:', error);
                        return null;
                    })
                ]);
                return { hardwareTiers, environments, projectSettings };
            } catch (error) {
                console.warn('Could not load configuration options:', error);
                return { hardwareTiers: [], environments: [], projectSettings: null };
            }
        });

        // Step 4: Select environment (required)
        if (configOptions.environments.length === 0) {
            vscode.window.showErrorMessage('No environments available. Cannot create workspace.');
            return;
        }

        const environmentOptions = configOptions.environments.map((env: any) => {
            const details = [];
            if (env.version && env.version !== 'N/A') { details.push(`v${env.version}`); }
            if (env.visibility) { details.push(env.visibility); }
            if (env.isCurated) { details.push('Curated'); }
            return {
                label: `${env.name}${env.isDefault ? ' (default)' : ''}`,
                description: details.length > 0 ? details.join(', ') : env.description || '',
                detail: `ID: ${env.id}`,
                value: env.id
            };
        });

        const defaultEnvIndex = environmentOptions.findIndex((option: any) =>
            configOptions.environments.find((env: any) => env.id === option.value && env.isDefault)
        );

        const selectedEnv = await vscode.window.showQuickPick(environmentOptions, {
            placeHolder: 'Select compute environment for the workspace',
            canPickMany: false,
            ...(defaultEnvIndex >= 0 && { activeItem: environmentOptions[defaultEnvIndex] })
        });

        if (!selectedEnv) {
            return;
        }

        // Step 5: Load available tools for selected environment
        const tools = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Loading available IDEs/tools...',
            cancellable: false
        }, async () => {
            try {
                return await dominoClient.getAvailableToolsForEnvironment(selectedEnv.value);
            } catch (error) {
                console.warn('Failed to get available tools:', error);
                return [];
            }
        });

        // Step 6: Select IDE/tool(s)
        if (tools.length === 0) {
            vscode.window.showErrorMessage('No tools/IDEs available for the selected environment.');
            return;
        }

        const toolOptions = tools.map((tool: any) => ({
            label: tool.title || tool.name,
            description: tool.name,
            detail: `Tool ID: ${tool.id}`,
            value: tool.name
        }));

        const selectedTool = await vscode.window.showQuickPick(toolOptions, {
            placeHolder: 'Select IDE for the workspace',
            canPickMany: false
        });

        if (!selectedTool) {
            return;
        }

        const selectedTools = [selectedTool];

        // Step 7: Select hardware tier (required)
        if (configOptions.hardwareTiers.length === 0) {
            vscode.window.showErrorMessage('No hardware tiers available. Cannot create workspace.');
            return;
        }

        const hardwareTierOptions = configOptions.hardwareTiers.map((tier: any) => {
            const details = [];
            if (tier.cpu !== 'N/A') { details.push(`${tier.cpu} CPU${tier.cpu !== '1' ? 's' : ''}`); }
            if (tier.memory !== 'N/A') { details.push(`${tier.memory} ${tier.memoryUnit || 'GiB'} RAM`); }
            if (tier.gpus && tier.gpus > 0) { details.push(`${tier.gpus} GPU${tier.gpus !== 1 ? 's' : ''}`); }
            const isDefault = tier.id === configOptions.projectSettings?.defaultHardwareTierId;
            return {
                label: `${tier.name}${isDefault ? ' (default)' : ''}`,
                description: details.length > 0 ? details.join(', ') : tier.description || '',
                detail: `ID: ${tier.id}`,
                value: tier.id
            };
        });

        const defaultTierIndex = hardwareTierOptions.findIndex((option: any) =>
            option.value === configOptions.projectSettings?.defaultHardwareTierId
        );

        const selectedTier = await vscode.window.showQuickPick(hardwareTierOptions, {
            placeHolder: 'Select hardware tier for the workspace',
            canPickMany: false,
            ...(defaultTierIndex >= 0 && { activeItem: hardwareTierOptions[defaultTierIndex] })
        });

        if (!selectedTier) {
            return;
        }

        // Step 8: Create workspace
        const workspace = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Creating workspace...',
            cancellable: false
        }, async () => {
            return await dominoClient.createWorkspace(
                workspaceName.trim(),
                selectedEnv.value,
                selectedTier.value,
                selectedTools.map((t: any) => t.value)
            );
        });

        // Step 9: Show success with action buttons
        const toolNames = selectedTools.map((t: any) => t.label).join(', ');
        const message = `Workspace "${workspaceName}" created with ${toolNames}!`;
        vscode.window.showInformationMessage(message, 'View Workspaces', 'Open in Domino')
            .then((selection: string | undefined) => {
                if (selection === 'View Workspaces') {
                    workspaceProvider.refresh();
                    vscode.commands.executeCommand('dominoWorkspaces.focus');
                } else if (selection === 'Open in Domino') {
                    const config = vscode.workspace.getConfiguration('domino');
                    const apiUrl = config.get<string>('apiUrl');
                    if (apiUrl && workspace?.id) {
                        const wsUrl = `${apiUrl}/workspace/${dominoClient.currentProjectId}/workspace/${workspace.id}`;
                        vscode.env.openExternal(vscode.Uri.parse(wsUrl));
                    }
                }
            });

        workspaceProvider.refresh();

    } catch (error) {
        console.error('Create workspace error:', error);
        vscode.window.showErrorMessage(`Failed to create workspace: ${error}`);
    }
}

async function openJobInBrowser(jobItem?: any) {
    try {
        console.log('Opening job in browser with item:', jobItem);
        
        // Handle both old format (separate parameters) and new format (job item object)
        let jobId: string;
        let username: string;
        let runId: string;
        
        if (typeof jobItem === 'string') {
            // Old format: function called with separate parameters
            jobId = jobItem;
            username = arguments[1] as string;
            runId = jobId; // Fallback
        } else if (jobItem && typeof jobItem === 'object') {
            // New format: job item object
            jobId = jobItem.jobId || jobItem.id;
            username = jobItem.ownerUsername || jobItem.username;
            runId = jobItem.runId || jobItem.jobId || jobItem.id;
            
            console.log('Extracted job details:', { jobId, username, runId });
        } else {
            vscode.window.showWarningMessage('Please select a job from the list');
            return;
        }

        // Validate required data
        if (!jobId) {
            vscode.window.showWarningMessage('Job ID not available');
            return;
        }

        if (!dominoClient.currentProjectId || !dominoClient.currentProjectName) {
            vscode.window.showWarningMessage('No project selected or project name not available');
            return;
        }

        // Get API URL from configuration
        const config = vscode.workspace.getConfiguration('domino');
        const apiUrl = config.get<string>('apiUrl');
        
        if (!apiUrl) {
            vscode.window.showWarningMessage('Domino API URL not configured');
            return;
        }

        // Fallback username if not available
        if (!username || username === 'Unknown user') {
            console.warn('Username not available, trying to get from project info or using fallback');
            // You might want to fetch this from the project or user info
            username = 'unknown'; // This should be replaced with actual logic to get the username
        }

        // Build the job URL - try different formats that Domino might use
        let jobUrl: string;
        
        // Format 1: Standard job results page
        jobUrl = `${apiUrl}/jobs/${username}/${dominoClient.currentProjectName}/${runId}/results`;
        
        console.log('Opening job URL:', jobUrl);
        console.log('URL components:', { apiUrl, username, projectName: dominoClient.currentProjectName, runId });
        
        // Open the URL
        vscode.env.openExternal(vscode.Uri.parse(jobUrl));
        
    } catch (error) {
        console.error('Failed to open job:', error);
        vscode.window.showErrorMessage(`Failed to open job: ${error}`);
    }
}

async function viewJobs() {
    try {
        if (!dominoClient.currentProjectId) {
            vscode.window.showWarningMessage('Please select a project first');
            return;
        }

        // Use the new paginated API - get more jobs for the webview (e.g., 50)
        const result = await dominoClient.getJobs(50, 0);
        
        const panel = vscode.window.createWebviewPanel(
            'dominoJobs',
            'Domino Jobs',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = generateJobsWebview(result.jobs, result.total, result.hasMore);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to view jobs: ${error}`);
    }
}

// New functions for enhanced job functionality
async function loadMoreJobs() {
    try {
        console.log('Loading more jobs...');
        await jobProvider.loadMore();
        vscode.window.showInformationMessage('Loading more jobs...');
    } catch (error) {
        console.error('Load more jobs error:', error);
        vscode.window.showErrorMessage(`Failed to load more jobs: ${error}`);
    }
}

async function startJobFromPanel() {
    // This will just call the existing runJob function
    await runJob();
}

async function copyJobId(jobItem?: any) {
    const id = jobItem?.jobId || jobItem?.id;
    if (!id) {
        vscode.window.showWarningMessage('No job ID available');
        return;
    }
    await vscode.env.clipboard.writeText(id);
    vscode.window.showInformationMessage(`Job ID copied: ${id}`);
}

async function copyWorkspaceId(workspaceItem?: any) {
    const id = workspaceItem?.workspaceId;
    if (!id) {
        vscode.window.showWarningMessage('No workspace ID available');
        return;
    }
    await vscode.env.clipboard.writeText(id);
    vscode.window.showInformationMessage(`Workspace ID copied: ${id}`);
}

async function openProjectInBrowser(projectItem?: any) {
    const projectName = projectItem?.label;
    const ownerUsername = projectItem?.ownerUsername;
    if (!projectName) {
        vscode.window.showWarningMessage('No project selected');
        return;
    }
    const config = vscode.workspace.getConfiguration('domino');
    const apiUrl = config.get<string>('apiUrl');
    if (!apiUrl) {
        vscode.window.showWarningMessage('Domino API URL not configured');
        return;
    }
    const projectUrl = ownerUsername
        ? `${apiUrl}/u/${ownerUsername}/${projectName}`
        : `${apiUrl}/projects`;
    vscode.env.openExternal(vscode.Uri.parse(projectUrl));
}

async function rerunJob(jobItem?: any) {
    if (!jobItem?.jobCommand) {
        vscode.window.showWarningMessage('No command available for this job');
        return;
    }
    await runJob(jobItem.jobCommand, jobItem.label);
}

function buildLogWebview(title: string, jobId: string, stdout: string, prepareOutput: string): string {
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const hasSetup = prepareOutput && prepareOutput !== '(empty)';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); margin: 0; padding: 16px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 4px; color: var(--vscode-foreground); }
  .meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
  details { border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px; margin-bottom: 12px; overflow: hidden; }
  summary { padding: 8px 12px; cursor: pointer; background: var(--vscode-sideBarSectionHeader-background, #2d2d2d); font-weight: 600; font-size: 12px; list-style: none; display: flex; align-items: center; gap: 8px; user-select: none; }
  summary::before { content: '▶'; font-size: 10px; transition: transform 0.15s; display: inline-block; }
  details[open] summary::before { transform: rotate(90deg); }
  pre { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-all; font-family: inherit; font-size: inherit; background: var(--vscode-editor-background); line-height: 1.5; }
</style>
</head>
<body>
  <h2>Domino Job Logs — ${escape(title)}</h2>
  <div class="meta">Job ID: ${escape(jobId)}</div>
  ${hasSetup ? `
  <details>
    <summary>Setup Output</summary>
    <pre>${escape(prepareOutput)}</pre>
  </details>` : ''}
  <details open>
    <summary>User Output</summary>
    <pre>${escape(stdout)}</pre>
  </details>
</body>
</html>`;
}

async function viewJobLogs(jobItem?: any) {
    const jobId = jobItem?.jobId || jobItem?.id;
    const jobTitle = jobItem?.label || jobId;

    if (!jobId) {
        vscode.window.showWarningMessage('No job selected');
        return;
    }

    try {
        const logs = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Fetching logs for "${jobTitle}"...`,
            cancellable: false,
        }, () => dominoClient.getJobLogs(jobId));

        const panel = vscode.window.createWebviewPanel(
            'dominoJobLogs',
            `Logs: ${jobTitle}`,
            vscode.ViewColumn.One,
            { enableScripts: false }
        );
        panel.webview.html = buildLogWebview(jobTitle, jobId, logs.stdout, logs.prepareOutput);
    } catch (error) {
        vscode.window.showErrorMessage(`Could not fetch logs: ${error}`);
    }
}

async function cancelJob(jobItem?: any) {
    const jobId = jobItem?.jobId || jobItem?.id;
    const jobTitle = jobItem?.label || jobId;

    if (!jobId) {
        vscode.window.showWarningMessage('No job selected');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Cancel job "${jobTitle}"?`,
        'Cancel Job',
        'Keep Running'
    );
    if (confirm !== 'Cancel Job') { return; }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Cancelling "${jobTitle}"...`,
            cancellable: false,
        }, () => dominoClient.cancelJob(jobId));

        vscode.window.showInformationMessage(`Job "${jobTitle}" cancelled.`);
        jobProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to cancel job: ${error}`);
    }
}

function generateJobsWebview(jobs: any[], total?: number, hasMore?: boolean): string {
    const totalText = total !== undefined ? ` (${jobs.length} of ${total} total)` : '';
    const moreText = hasMore ? '<p><em>Showing first 50 jobs. Use the sidebar to load more.</em></p>' : '';
    
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { padding: 8px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
                th { background-color: var(--vscode-editor-background); font-weight: bold; }
                .status-running { color: var(--vscode-charts-blue); }
                .status-succeeded { color: var(--vscode-charts-green); }
                .status-failed { color: var(--vscode-charts-red); }
                .status-queued { color: var(--vscode-charts-yellow); }
                .job-title { font-weight: bold; }
                .job-command { font-family: monospace; background: var(--vscode-textBlockQuote-background); padding: 2px 4px; border-radius: 3px; }
            </style>
        </head>
        <body>
            <h2>Domino Jobs${totalText}</h2>
            ${moreText}
            ${jobs.length === 0 ? '<p>No jobs found in this project.</p>' : `
            <table>
                <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Command</th>
                    <th>Started By</th>
                    <th>Date</th>
                </tr>
                ${jobs.map(job => {
                    const status = job.statuses?.executionStatus || 'Unknown';
                    const title = job.title || `Job #${job.number || job.id.slice(-4)}`;
                    const command = job.jobRunCommand || 'No command';
                    const startedBy = job.startedBy?.username || 'Unknown';
                    const date = job.stageTime?.completedTime || job.stageTime?.runStartTime;
                    const dateString = date ? new Date(date).toLocaleString() : 'N/A';
                    
                    return `
                    <tr>
                        <td class="job-title">${title}</td>
                        <td class="status-${status.toLowerCase()}">${status}</td>
                        <td class="job-command">${command}</td>
                        <td>${startedBy}</td>
                        <td>${dateString}</td>
                    </tr>
                `;
                }).join('')}
            </table>
            `}
        </body>
        </html>
    `;
}

async function checkAuthentication() {
    const config = vscode.workspace.getConfiguration('domino');
    const autoRefreshEnabled = config.get<boolean>('autoRefreshEnabled', true);
    isAutoRefreshEnabled = autoRefreshEnabled;

    const tokens = await loadTokens(secretStorage);
    if (!tokens) {
        vscode.commands.executeCommand('setContext', 'domino:authenticated', false);
        return;
    }

    const clientId = config.get<string>('oauthClientId', 'domino-connect-client');

    // If the access token has expired, attempt a silent refresh before restoring the session
    let activeTokens = tokens;
    if (tokens.expiresAt <= Date.now()) {
        try {
            activeTokens = await refreshAccessToken(tokens, clientId);
            await storeTokens(secretStorage, activeTokens);
        } catch (error) {
            console.log('Stored tokens expired and refresh failed — clearing:', error);
            await clearTokens(secretStorage);
            vscode.commands.executeCommand('setContext', 'domino:authenticated', false);
            return;
        }
    }

    try {
        await dominoClient.authenticate(activeTokens.dominoBaseUrl, activeTokens.accessToken);
    } catch (error) {
        console.log('Stored tokens are invalid — clearing:', error);
        await clearTokens(secretStorage);
        vscode.commands.executeCommand('setContext', 'domino:authenticated', false);
        return;
    }

    scheduleTokenRefresh(activeTokens);
    vscode.commands.executeCommand('setContext', 'domino:authenticated', true);
    console.log('Auto-authenticated with stored OAuth tokens');

    // Fetch current user for status bar
    try {
        const self = await dominoClient.getSelf();
        currentUserName = self.userName || '';
    } catch { /* non-critical */ }
    updateStatusBar();

    projectProvider.refresh();
    jobProvider.refresh();
    workspaceProvider.refresh();
    startAutoRefresh();
}

export function deactivate() {
    // Clean up auto-refresh timer
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = undefined;
    }

    // Clean up OAuth token refresh timer
    if (tokenRefreshTimer) {
        clearTimeout(tokenRefreshTimer);
        tokenRefreshTimer = undefined;
    }

    // Clean up SSH tunnels — terminal-based tunnels only.
    // Background tunnels are intentionally left running so they survive VSCode closing.
    for (const [id, tunnel] of activeTunnels.entries()) {
        if (!tunnel.isBackground) {
            tunnel.terminal!.dispose();
            removeSshConfigEntry(id);
        }
    }
    activeTunnels.clear();
}

let dominoClient: DominoApiClient;
let projectProvider: ProjectProvider;
let jobProvider: JobProvider;
let workspaceProvider: WorkspaceProvider;
let secretStorage: vscode.SecretStorage;
let statusBarItem: vscode.StatusBarItem;
let currentUserName: string = '';

function updateStatusBar(): void {
    if (!statusBarItem) { return; }
    if (!dominoClient.isAuthenticated) {
        statusBarItem.hide();
        return;
    }
    if (dominoClient.currentProjectName) {
        const label = dominoClient.currentOwnerUsername
            ? `${dominoClient.currentOwnerUsername}/${dominoClient.currentProjectName}`
            : dominoClient.currentProjectName;
        statusBarItem.text = `$(project) ${label}`;
        statusBarItem.tooltip = `Project: ${label}${currentUserName ? ` | User: ${currentUserName}` : ''}\nClick to change project`;
    } else {
        statusBarItem.text = `$(account) Domino`;
        statusBarItem.tooltip = `${currentUserName ? `Signed in as ${currentUserName}. ` : ''}Click to select a project`;
    }
    statusBarItem.show();
}

// Auto-refresh functionality
let autoRefreshTimer: NodeJS.Timeout | undefined;
let isAutoRefreshEnabled: boolean = true;
const AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

// OAuth token refresh timer
let tokenRefreshTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Domino Data Lab extension is now active!');
    
    // Log extension host type for debugging
    const extensionKind = vscode.extensions.getExtension('your-publisher-name.domino-datalab')?.extensionKind;
    console.log('Extension running in:', extensionKind === vscode.ExtensionKind.UI ? 'Local (UI)' : 'Remote (Workspace)');
    
    // Check if we're in a remote workspace
    const isRemote = vscode.env.remoteName !== undefined;
    console.log('Remote workspace detected:', isRemote, 'Remote name:', vscode.env.remoteName);

    // Store secret storage for credential persistence
    secretStorage = context.secrets;

    // Initialize providers
    dominoClient = new DominoApiClient();
    projectProvider = new ProjectProvider(dominoClient);
    jobProvider = new JobProvider(dominoClient);
    workspaceProvider = new WorkspaceProvider(dominoClient, activeTunnels);

    // Status bar item — shows current project and logged-in user
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'domino.selectProject';
    context.subscriptions.push(statusBarItem);

    // Register tree data providers
    vscode.window.registerTreeDataProvider('dominoProjects', projectProvider);
    vscode.window.registerTreeDataProvider('dominoJobs', jobProvider);
    vscode.window.registerTreeDataProvider('dominoWorkspaces', workspaceProvider);

    // Register commands
    const commands = [
        vscode.commands.registerCommand('domino.authenticate', authenticate),
        vscode.commands.registerCommand('domino.selectProject', selectProject),
        vscode.commands.registerCommand('domino.createProject', createProject),
        vscode.commands.registerCommand('domino.runJob', runJob),
        vscode.commands.registerCommand('domino.viewJobs', viewJobs),
        vscode.commands.registerCommand('domino.startWorkspace', startWorkspace),
        vscode.commands.registerCommand('domino.stopWorkspace', stopWorkspace),
        vscode.commands.registerCommand('domino.openWorkspace', openWorkspace),
        vscode.commands.registerCommand('domino.commitWorkspace', commitWorkspace),
        vscode.commands.registerCommand('domino.createWorkspace', createNewWorkspace),
        vscode.commands.registerCommand('domino.openJobInBrowser', openJobInBrowser),
        vscode.commands.registerCommand('domino.refreshProjects', () => projectProvider.refresh()),
        vscode.commands.registerCommand('domino.refreshJobs', () => jobProvider.refresh()),
        vscode.commands.registerCommand('domino.refreshWorkspaces', () => workspaceProvider.refresh()),
        // New commands for enhanced job functionality
        vscode.commands.registerCommand('domino.loadMoreJobs', loadMoreJobs),
        vscode.commands.registerCommand('domino.startJobFromPanel', startJobFromPanel),
        // Auto-refresh commands
        vscode.commands.registerCommand('domino.toggleAutoRefresh', toggleAutoRefresh),
        vscode.commands.registerCommand('domino.enableAutoRefresh', enableAutoRefresh),
        vscode.commands.registerCommand('domino.disableAutoRefresh', disableAutoRefresh),
        // File context menu command
        vscode.commands.registerCommand('domino.runJobWithFile', runJobWithFile),
        // SSH tunnel commands
        vscode.commands.registerCommand('domino.connectSSH', connectSSH),
        vscode.commands.registerCommand('domino.disconnectSSH', disconnectSSH),
        // Auth commands
        vscode.commands.registerCommand('domino.signOut', signOut),
        vscode.commands.registerCommand('domino.copyJobId', copyJobId),
        vscode.commands.registerCommand('domino.copyWorkspaceId', copyWorkspaceId),
        vscode.commands.registerCommand('domino.openProjectInBrowser', openProjectInBrowser),
        vscode.commands.registerCommand('domino.rerunJob', rerunJob),
        vscode.commands.registerCommand('domino.viewJobLogs', viewJobLogs),
        vscode.commands.registerCommand('domino.cancelJob', cancelJob),
    ];

    context.subscriptions.push(...commands);

    // Add auto-refresh timer to subscriptions for proper cleanup
    context.subscriptions.push({
        dispose: () => {
            if (autoRefreshTimer) {
                clearInterval(autoRefreshTimer);
                autoRefreshTimer = undefined;
            }
            if (tokenRefreshTimer) {
                clearTimeout(tokenRefreshTimer);
                tokenRefreshTimer = undefined;
            }
        }
    });

    // Add SSH tunnel cleanup disposable — terminal-based tunnels only.
    // Background tunnels are intentionally left running so they survive VSCode closing.
    context.subscriptions.push({
        dispose: () => {
            for (const [id, tunnel] of activeTunnels.entries()) {
                if (!tunnel.isBackground) {
                    tunnel.terminal!.dispose();
                    removeSshConfigEntry(id);
                }
            }
            activeTunnels.clear();
        }
    });

    // Listen for terminal close to clean up tunnels
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal((closedTerminal) => {
            for (const [id, tunnel] of activeTunnels.entries()) {
                if (tunnel.terminal === closedTerminal) {
                    activeTunnels.delete(id);
                    removeSshConfigEntry(id);
                    workspaceProvider.refresh();
                    vscode.window.showWarningMessage(
                        `SSH tunnel to "${tunnel.workspaceName}" disconnected`
                    );
                    break;
                }
            }
        })
    );

    // Check if already authenticated
    checkAuthentication();

    // Restore any background SSH proxies that survived a previous VSCode session
    restoreBackgroundTunnels();
}

// Token refresh scheduling

function scheduleTokenRefresh(tokens: TokenSet): void {
    if (tokenRefreshTimer) {
        clearTimeout(tokenRefreshTimer);
        tokenRefreshTimer = undefined;
    }

    const timeUntilExpiry = tokens.expiresAt - Date.now();
    // Refresh at 80% of the token lifetime, with a 30-second minimum floor
    const refreshIn = Math.max(timeUntilExpiry * 0.8, 30_000);

    const expiresAt = new Date(tokens.expiresAt).toLocaleTimeString();
    const refreshAt = new Date(Date.now() + refreshIn).toLocaleTimeString();
    console.log(`[Domino auth] Token expires at ${expiresAt}. Refresh scheduled in ${Math.round(refreshIn / 1000)}s (at ${refreshAt}).`);

    tokenRefreshTimer = setTimeout(async () => {
        console.log('[Domino auth] Starting background token refresh...');
        try {
            const config = vscode.workspace.getConfiguration('domino');
            const clientId = config.get<string>('oauthClientId', 'domino-connect-client');
            const newTokens = await refreshAccessToken(tokens, clientId);
            await storeTokens(secretStorage, newTokens);
            dominoClient.updateAccessToken(newTokens.accessToken);
            console.log(`[Domino auth] Token refreshed successfully. New token expires at ${new Date(newTokens.expiresAt).toLocaleTimeString()}.`);
            scheduleTokenRefresh(newTokens);
        } catch (error) {
            console.error('[Domino auth] Background token refresh failed:', error);
            await clearTokens(secretStorage);
            stopAutoRefresh();
            vscode.commands.executeCommand('setContext', 'domino:authenticated', false);
            vscode.window.showWarningMessage(
                'Your Domino session has expired. Please sign in again.',
                'Sign In'
            ).then(action => {
                if (action === 'Sign In') { authenticate(); }
            });
        }
    }, refreshIn);
}

// Auto-refresh functions
function startAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
    }
    
    if (!isAutoRefreshEnabled) {
        return;
    }

    console.log('Starting auto-refresh timer (30 seconds)');
    
    autoRefreshTimer = setInterval(() => {
        if (dominoClient.currentProjectId && isAutoRefreshEnabled) {
            console.log('Auto-refreshing jobs and workspaces...');
            
            try {
                jobProvider.refresh();
                workspaceProvider.refresh();
            } catch (error) {
                console.error('Error during auto-refresh:', error);
            }
        }
    }, AUTO_REFRESH_INTERVAL);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        console.log('Stopping auto-refresh timer');
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = undefined;
    }
}

async function toggleAutoRefresh() {
    isAutoRefreshEnabled = !isAutoRefreshEnabled;
    
    if (isAutoRefreshEnabled) {
        startAutoRefresh();
        vscode.window.showInformationMessage('Auto-refresh enabled (every 30 seconds)');
    } else {
        stopAutoRefresh();
        vscode.window.showInformationMessage('Auto-refresh disabled');
    }
    
    const config = vscode.workspace.getConfiguration('domino');
    await config.update('autoRefreshEnabled', isAutoRefreshEnabled, vscode.ConfigurationTarget.Global);
}

async function enableAutoRefresh() {
    if (!isAutoRefreshEnabled) {
        isAutoRefreshEnabled = true;
        startAutoRefresh();
        vscode.window.showInformationMessage('Auto-refresh enabled (every 30 seconds)');
        
        const config = vscode.workspace.getConfiguration('domino');
        await config.update('autoRefreshEnabled', true, vscode.ConfigurationTarget.Global);
    }
}