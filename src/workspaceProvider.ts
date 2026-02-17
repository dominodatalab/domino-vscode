import * as vscode from 'vscode';
import { DominoApiClient } from './dominoApiClient';

// Union type for workspace tree items
type WorkspaceTreeItem = WorkspaceItem | WorkspaceHeaderItem | WorkspaceActionItem;

export class WorkspaceProvider implements vscode.TreeDataProvider<WorkspaceTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<WorkspaceTreeItem | undefined | null | void> = new vscode.EventEmitter<WorkspaceTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<WorkspaceTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(
        private dominoClient: DominoApiClient,
        private activeTunnels: Map<string, { port: number }> = new Map()
    ) {
        console.log('WorkspaceProvider: Constructor called');
    }

    refresh(): void {
        console.log('WorkspaceProvider: Refresh called');
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: WorkspaceTreeItem): vscode.TreeItem {
        console.log('WorkspaceProvider: getTreeItem called for:', element.label);
        return element;
    }

    async getChildren(element?: WorkspaceTreeItem): Promise<WorkspaceTreeItem[]> {
        try {
            if (!this.dominoClient.isAuthenticated) {
                return [];
            }

            if (!this.dominoClient.currentProjectId) {
                console.log('WorkspaceProvider: No project selected');
                return [
                    new WorkspaceHeaderItem('🎯 Select a project to view workspaces', 'project-needed')
                ];
            }

            console.log('WorkspaceProvider: Getting workspaces...');
            const workspaces = await this.dominoClient.getWorkspaces();
            console.log('WorkspaceProvider: Received workspaces:', workspaces);
            
            const items: WorkspaceTreeItem[] = [];
            
            if (!workspaces || workspaces.length === 0) {
                console.log('WorkspaceProvider: No workspaces found');
                items.push(new WorkspaceHeaderItem('📋 No workspaces found', 'no-workspaces'));
                items.push(new WorkspaceActionItem(
                    '➕ Create New Workspace',
                    'create-workspace',
                    'Create and start a new workspace in this project',
                    'add'
                ));
                return items;
            }

            // Add summary header
            const runningCount = workspaces.filter(ws => ws.state?.toLowerCase() === 'started' || ws.state?.toLowerCase() === 'running').length;
            const stoppedCount = workspaces.length - runningCount;
            
            let summaryText = `💻 ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`;
            if (runningCount > 0) {
                summaryText += ` • ${runningCount} running`;
            }
            if (stoppedCount > 0) {
                summaryText += ` • ${stoppedCount} stopped`;
            }
            
            items.push(new WorkspaceHeaderItem(summaryText, 'workspaces-summary'));

            // Add "Create New Workspace" action button
            items.push(new WorkspaceActionItem(
                '➕ Create New Workspace',
                'create-workspace',
                'Create and start a new workspace in this project',
                'add'
            ));

            const workspaceItems = workspaces.map(workspace => {
                console.log('WorkspaceProvider: Processing workspace:', {
                    id: workspace.id,
                    name: workspace.name,
                    state: workspace.state,
                    ownerName: workspace.ownerName,
                    createdAt: workspace.createdAt,
                    stateUpdatedAt: workspace.stateUpdatedAt,
                    mostRecentSession: workspace.mostRecentSession
                });
                
                // Extract relevant data from the workspace structure
                const workspaceId = workspace.id || 'unknown-id';
                const workspaceName = workspace.name || `${workspace.ownerName}'s workspace` || `Workspace ${workspaceId.slice(-4)}`;
                const status = workspace.state || 'Unknown';
                const createdTime = workspace.createdAt || workspace.stateUpdatedAt || '';
                
                // Try to get URL from session or construct it
                let workspaceUrl = '';
                if (workspace.mostRecentSession && workspace.configTemplate) {
                    const host = this.dominoClient.apiHost;
                    workspaceUrl = `https://${host}/workspace/${workspaceId}`;
                }
                
                const tunnel = this.activeTunnels.get(workspaceId);
                return new WorkspaceItem(
                    workspaceName,
                    status,
                    workspaceId,
                    workspaceUrl,
                    createdTime,
                    workspace.ownerName || 'Unknown',
                    vscode.TreeItemCollapsibleState.None,
                    tunnel?.port
                );
            });
            
            items.push(...workspaceItems);
            
            console.log(`WorkspaceProvider: Created ${workspaceItems.length} workspace items`);
            return items;
        } catch (error) {
            console.error('WorkspaceProvider error:', error);
            return [
                new WorkspaceHeaderItem('❌ Error loading workspaces', 'error'),
                new WorkspaceHeaderItem('🔄 Try refreshing the view', 'help-text')
            ];
        }
    }
}

class WorkspaceItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly status: string,
        public readonly workspaceId: string,
        public readonly url: string,
        public readonly startedTime: string,
        public readonly ownerName: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly tunnelPort?: number
    ) {
        super(label, collapsibleState);

        // Create enhanced description with status indicator and owner info
        const statusIndicator = this.getStatusIndicator(status);
        const ownerInfo = ownerName && ownerName !== 'Unknown' ? ` • by ${ownerName}` : '';
        const sshInfo = tunnelPort ? ` • SSH :${tunnelPort}` : '';
        this.description = `${statusIndicator} ${status}${ownerInfo}${sshInfo}`;

        // Enhanced tooltip with markdown formatting
        const formattedTime = startedTime ? new Date(startedTime).toLocaleString() : 'N/A';
        const sshTooltip = tunnelPort
            ? `\n🔌 **SSH Tunnel:** Active on port ${tunnelPort}  \n💻 **SSH Command:** \`ssh -p ${tunnelPort} ubuntu@localhost\``
            : '';
        this.tooltip = new vscode.MarkdownString(`
**${label}**

${statusIndicator} **Status:** ${status}
👤 **Owner:** ${ownerName}
📅 **Created:** ${formattedTime}
🆔 **Workspace ID:** \`${workspaceId}\`
${url ? `🔗 **URL:** ${url}` : ''}${sshTooltip}

${status.toLowerCase() === 'started' || status.toLowerCase() === 'running'
    ? '*Workspace is ready for use*'
    : '*Start workspace to begin working*'}
        `);

        // Set context value based on status and tunnel state for menu items
        const isRunning = status.toLowerCase() === 'started' || status.toLowerCase() === 'running';
        if (isRunning && tunnelPort) {
            this.contextValue = 'workspace-running-ssh';
        } else if (isRunning) {
            this.contextValue = 'workspace-running';
        } else {
            this.contextValue = 'workspace-stopped';
        }
        
        // Set icon and color based on status
        switch (status.toLowerCase()) {
            case 'started':
            case 'running':
                this.iconPath = new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconPassed'));
                break;
            case 'starting':
                this.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('testing.runAction'));
                break;
            case 'stopping':
                this.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.orange'));
                break;
            case 'stopped':
                this.iconPath = new vscode.ThemeIcon('vm', new vscode.ThemeColor('testing.iconSkipped'));
                break;
            case 'failed':
            case 'error':
                this.iconPath = new vscode.ThemeIcon('vm-outline', new vscode.ThemeColor('testing.iconFailed'));
                break;
            default:
                this.iconPath = new vscode.ThemeIcon('vm-outline', new vscode.ThemeColor('descriptionForeground'));
        }
    }
    
    private getStatusIndicator(status: string): string {
        switch (status.toLowerCase()) {
            case 'started':
            case 'running':
                return '🟢';
            case 'starting':
                return '🟡';
            case 'stopping':
                return '🟠';
            case 'stopped':
                return '⚫';
            case 'failed':
            case 'error':
                return '🔴';
            default:
                return '⚪';
        }
    }
}

// Header item for the workspace list
class WorkspaceHeaderItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly headerType: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        
        // Style based on header type
        this.description = '';
        this.contextValue = 'workspaceHeader';
        
        // Set appropriate icon and styling based on type
        switch (headerType) {
            case 'project-needed':
                this.iconPath = new vscode.ThemeIcon('target', new vscode.ThemeColor('charts.orange'));
                this.tooltip = 'Select a project from the Projects panel to view its workspaces';
                break;
            case 'workspaces-summary':
                this.iconPath = new vscode.ThemeIcon('server-environment', new vscode.ThemeColor('charts.blue'));
                this.tooltip = 'Workspace status summary for this project';
                break;
            case 'no-workspaces':
                this.iconPath = new vscode.ThemeIcon('desktop-download', new vscode.ThemeColor('descriptionForeground'));
                this.tooltip = 'No workspaces have been created in this project yet';
                break;
            case 'help-text':
                this.iconPath = new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('charts.yellow'));
                this.tooltip = 'Helpful tip for getting started with workspaces';
                break;
            case 'error':
                this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'));
                this.tooltip = 'There was an error loading workspaces';
                break;
            default:
                this.iconPath = new vscode.ThemeIcon('info', new vscode.ThemeColor('descriptionForeground'));
        }
        
        // Make it look like a header (no command, not clickable)
        this.command = undefined;
    }
}

// Action item for creating new workspaces
class WorkspaceActionItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly actionId: string,
        public readonly actionDescription: string,
        public readonly iconName: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = '';
        this.tooltip = new vscode.MarkdownString(`**${actionDescription}**\n\n*Click to start creating a new workspace*`);
        this.contextValue = 'workspaceAction';
        this.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor('button.background'));
        this.command = {
            command: 'domino.createWorkspace',
            title: 'Create New Workspace',
            arguments: []
        };
    }
}
