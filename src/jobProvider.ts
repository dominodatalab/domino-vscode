import * as vscode from 'vscode';
import { DominoApiClient } from './dominoApiClient';

// Union type for all tree items
type JobTreeItem = JobItem | JobHeaderItem | JobActionItem | LoadMoreItem;

export class JobProvider implements vscode.TreeDataProvider<JobTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<JobTreeItem | undefined | null | void> = new vscode.EventEmitter<JobTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<JobTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private jobs: any[] = [];
    private hasMore: boolean = false;
    private total: number = 0;
    private currentOffset: number = 0;
    private readonly pageSize: number = 20;

    constructor(private dominoClient: DominoApiClient) {
        console.log('JobProvider: Constructor called');
    }

    refresh(): void {
        console.log('JobProvider: Refresh called - resetting pagination');
        this.currentOffset = 0; // Reset pagination
        this.jobs = []; // Clear existing jobs
        this.hasMore = false; // Reset hasMore flag
        this.total = 0; // Reset total
        this._onDidChangeTreeData.fire();
    }

    async loadMore(): Promise<void> {
        console.log('JobProvider: Load more called');
        this.currentOffset += this.pageSize;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: JobTreeItem): vscode.TreeItem {
        console.log('JobProvider: getTreeItem called for:', element.label);
        return element;
    }

    async getChildren(element?: JobTreeItem): Promise<JobTreeItem[]> {
        try {
            if (!this.dominoClient.isAuthenticated) {
                return [];
            }

            if (!this.dominoClient.currentProjectId) {
                console.log('No project selected for jobs');
                return [
                    new JobHeaderItem('Select a project to view jobs', 'project-needed'),
                    new JobActionItem('Start New Job', 'start-job', 'Start a new job in this project', 'play')
                ];
            }

            console.log('JobProvider: Getting jobs...');
            
            // Load jobs for current page
            const result = await this.dominoClient.getJobs(this.pageSize, this.currentOffset);
            console.log(`JobProvider: API returned ${result.jobs.length} jobs, offset: ${this.currentOffset}, total available: ${result.total}`);
            
            // If this is a fresh load (offset 0), replace the jobs array
            if (this.currentOffset === 0) {
                this.jobs = [...result.jobs]; // Use spread operator to ensure new array
                console.log(`JobProvider: Fresh load, set jobs array to ${this.jobs.length} items`);
            } else {
                // Append to existing jobs
                this.jobs.push(...result.jobs);
                console.log(`JobProvider: Appended jobs, total now: ${this.jobs.length}`);
            }
            
            this.hasMore = result.hasMore;
            this.total = result.total || 0;
            
            console.log('JobProvider: Final state:', {
                displayingJobs: this.jobs.length,
                hasMore: this.hasMore,
                total: this.total,
                offset: this.currentOffset
            });
            
            const items: JobTreeItem[] = [];
            
            // Add header with job count and action button
            if (this.total > 0) {
                const headerText = `📊 ${this.total} job${this.total === 1 ? '' : 's'} • ${this.jobs.length} loaded`;
                items.push(new JobHeaderItem(headerText, 'jobs-summary'));
            } else {
                items.push(new JobHeaderItem('No jobs found', 'no-jobs'));
            }
            
            // Add "Start New Job" action button
            items.push(new JobActionItem(
                'Start New Job',
                'start-job', 
                'Create and run a new job in this project', 
                'play'
            ));
            
            if (this.jobs.length === 0 && this.total === 0) {
                // No jobs at all - show helpful message
                items.push(new JobHeaderItem('💡 Click "Start New Job" to create your first job', 'help-text'));
                return items;
            }

            // Add job items
            const jobItems = this.jobs.map((job, index) => {
                console.log(`Processing job ${index + 1}:`, {
                    id: job.id,
                    number: job.number,
                    title: job.title,
                    status: job.statuses?.executionStatus,
                    command: job.jobRunCommand,
                    startedBy: job.startedBy?.username,
                    completedTime: job.stageTime?.completedTime,
                    runId: job.runId || job.id,
                    ownerUsername: job.ownerUsername || job.startedBy?.username
                });
                
                // Format the date nicely
                let dateString = 'Unknown date';
                let timeAgo = '';
                if (job.stageTime?.completedTime) {
                    const date = new Date(job.stageTime.completedTime);
                    dateString = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    
                    // Calculate time ago
                    const now = new Date();
                    const diffMs = now.getTime() - date.getTime();
                    const diffMins = Math.floor(diffMs / (1000 * 60));
                    const diffHours = Math.floor(diffMins / 60);
                    const diffDays = Math.floor(diffHours / 24);
                    
                    if (diffMins < 60) {
                        timeAgo = `${diffMins}m ago`;
                    } else if (diffHours < 24) {
                        timeAgo = `${diffHours}h ago`;
                    } else {
                        timeAgo = `${diffDays}d ago`;
                    }
                } else if (job.stageTime?.runStartTime) {
                    const date = new Date(job.stageTime.runStartTime);
                    dateString = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    timeAgo = 'running';
                }
                
                // Create a nice display name
                const jobTitle = job.title || `Job #${job.number || job.id.slice(-4)}`;
                const command = job.jobRunCommand || 'No command';
                const status = job.statuses?.executionStatus || 'Unknown';
                
                // Format command nicely (truncate if too long)
                const displayCommand = command.length > 25 ? command.substring(0, 22) + '...' : command;
                
                // Create enhanced JobItem with all necessary data
                const jobItem = new JobItem(
                    jobTitle,
                    status,
                    job.id,
                    command,
                    displayCommand,
                    timeAgo,
                    dateString,
                    job.startedBy?.username || 'Unknown user',
                    vscode.TreeItemCollapsibleState.None,
                    job.number?.toString()
                );
                
                // Add additional properties for browser link
                (jobItem as any).runId = job.runId || job.id;
                (jobItem as any).ownerUsername = job.ownerUsername || job.startedBy?.username;
                (jobItem as any).jobData = job; // Store full job data for reference
                
                return jobItem;
            });
            
            items.push(...jobItems);
            
            console.log(`JobProvider: Created ${jobItems.length} job items from ${this.jobs.length} jobs`);
            
            // Add "Load More" button if there are more jobs
            if (this.hasMore) {
                const remaining = this.total - this.jobs.length;
                items.push(new LoadMoreItem(`📥 Load ${Math.min(remaining, this.pageSize)} more (${remaining} remaining)`));
                console.log(`JobProvider: Added load more button, ${remaining} jobs remaining`);
            }
            
            console.log(`JobProvider: Returning ${items.length} total items to display`);
            return items;
        } catch (error) {
            console.error('JobProvider error:', error);
            return [
                new JobHeaderItem('Error loading jobs', 'error'),
                new JobActionItem('Start New Job', 'start-job', 'Start a new job in this project', 'play'),
                new JobHeaderItem('Try refreshing the view', 'help-text')
            ];
        }
    }
}

class JobItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly status: string,
        public readonly jobId: string,
        public readonly jobCommand: string,
        public readonly displayCommand: string,
        public readonly timeAgo: string,
        public readonly fullDate: string,
        public readonly username: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly jobNumber?: string
    ) {
        super(label, collapsibleState);
        
        this.description = `${displayCommand} • ${timeAgo}`;

        // Rich tooltip with all details
        this.tooltip = new vscode.MarkdownString(`
**${label}**

**Status:** ${status}
**Command:** \`${jobCommand}\`
**Date:** ${fullDate}
**Started by:** ${username}
**Job ID:** \`${jobId}\`
${jobNumber ? `**Job Number:** ${jobNumber}` : ''}

*Click to view in Domino*
        `);
        
        this.contextValue = 'job';
        
        // Set icon and color based on status
        switch (status.toLowerCase()) {
            case 'running':
                this.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('testing.runAction'));
                break;
            case 'succeeded':
                this.iconPath = new vscode.ThemeIcon('check-all', new vscode.ThemeColor('testing.iconPassed'));
                break;
            case 'failed':
                this.iconPath = new vscode.ThemeIcon('x', new vscode.ThemeColor('testing.iconFailed'));
                break;
            case 'queued':
                this.iconPath = new vscode.ThemeIcon('clock', new vscode.ThemeColor('testing.iconQueued'));
                break;
            case 'stopped':
                this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconSkipped'));
                break;
            default:
                this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('foreground'));
        }

        // Add command to open job in browser when clicked
        this.command = {
            command: 'domino.openJobInBrowser',
            title: 'Open Job in Browser',
            arguments: [this] // Pass the entire job item
        };
    }
    
}

// Header item for the jobs list
class JobHeaderItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly headerType: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        
        // Style based on header type
        this.description = '';
        this.contextValue = 'jobHeader';
        
        // Set appropriate icon and styling based on type
        switch (headerType) {
            case 'project-needed':
                this.iconPath = new vscode.ThemeIcon('target', new vscode.ThemeColor('charts.orange'));
                this.tooltip = 'Select a project from the Projects panel to view its jobs';
                break;
            case 'jobs-summary':
                this.iconPath = new vscode.ThemeIcon('graph', new vscode.ThemeColor('charts.blue'));
                this.tooltip = 'Job execution summary for this project';
                break;
            case 'no-jobs':
                this.iconPath = new vscode.ThemeIcon('inbox', new vscode.ThemeColor('descriptionForeground'));
                this.tooltip = 'No jobs have been created in this project yet';
                break;
            case 'help-text':
                this.iconPath = new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('charts.yellow'));
                this.tooltip = 'Helpful tip for getting started';
                break;
            case 'error':
                this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'));
                this.tooltip = 'There was an error loading jobs';
                break;
            default:
                this.iconPath = new vscode.ThemeIcon('info', new vscode.ThemeColor('descriptionForeground'));
        }
        
        // Make it look like a header (no command, not clickable)
        this.command = undefined;
    }
}

// Action item for starting new jobs
class JobActionItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly actionId: string,
        public readonly actionDescription: string,
        public readonly iconName: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        
        this.description = '';
        this.tooltip = new vscode.MarkdownString(`**${actionDescription}**\n\n*Click to start creating a new job*`);
        this.contextValue = 'jobAction';
        
        // Use a prominent icon with accent color
        this.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor('button.background'));
        
        // Add command to execute the action
        this.command = {
            command: 'domino.runJob',
            title: 'Start New Job',
            arguments: []
        };
    }
}

// Load more item for pagination
class LoadMoreItem extends vscode.TreeItem {
    constructor(
        public readonly label: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        
        this.description = '';
        this.tooltip = new vscode.MarkdownString('**Load more jobs**\n\n*Click to fetch additional jobs from the server*');
        this.contextValue = 'loadMore';
        
        // Use a distinctive icon
        this.iconPath = new vscode.ThemeIcon('fold-down', new vscode.ThemeColor('button.secondaryBackground'));
        
        // Add command to load more
        this.command = {
            command: 'domino.loadMoreJobs',
            title: 'Load More Jobs',
            arguments: []
        };
    }
}