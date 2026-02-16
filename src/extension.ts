import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { DominoApiClient } from './dominoApiClient';
import { ProjectProvider } from './projectProvider';
import { JobProvider } from './jobProvider';
import { WorkspaceProvider } from './workspaceProvider';

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
        const apiUrl = await vscode.window.showInputBox({
            prompt: 'Enter your Domino API URL',
            placeHolder: 'https://your-domino-instance.com'
        });

        if (!apiUrl) {
            return;
        }

        const apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your Domino API Key',
            password: true
        });

        if (!apiKey) {
            return;
        }

        await dominoClient.authenticate(apiUrl, apiKey);
        
        // Set context for views
        vscode.commands.executeCommand('setContext', 'domino:authenticated', true);
        
        // Update configuration
        const config = vscode.workspace.getConfiguration('domino');
        await config.update('apiUrl', apiUrl, vscode.ConfigurationTarget.Global);

        vscode.window.showInformationMessage('Successfully authenticated with Domino!');
        
        // Refresh views
        projectProvider.refresh();
        jobProvider.refresh();
        workspaceProvider.refresh();

        // Start auto-refresh after successful authentication
        startAutoRefresh();

    } catch (error) {
        vscode.window.showErrorMessage(`Authentication failed: ${error}`);
    }
}

async function selectProject(projectItem?: any) {
    try {
        // If called from tree view with a project item, use it directly
        if (projectItem && projectItem.projectId && projectItem.label) {
            console.log('Selecting project from tree view:', projectItem.label);
            await dominoClient.setCurrentProject(projectItem.projectId, projectItem.label);
            vscode.window.showInformationMessage(`Selected project: ${projectItem.label}`);
            
            // Update status bar
            vscode.window.setStatusBarMessage(`Domino: ${projectItem.label}`, 5000);
            
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
            
            await dominoClient.setCurrentProject(project.id, project.name);
            vscode.window.showInformationMessage(`Auto-selected project: ${project.name}`);
            
            // Update status bar
            vscode.window.setStatusBarMessage(`Domino: ${project.name}`, 5000);
            
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
            await dominoClient.setCurrentProject(selected.project.id, selected.project.name);
            vscode.window.showInformationMessage(`Selected project: ${selected.project.name}`);
            
            // Update status bar
            vscode.window.setStatusBarMessage(`Domino: ${selected.project.name}`, 5000);
            
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

async function runJob() {
    try {
        if (!dominoClient.currentProjectId) {
            vscode.window.showWarningMessage('Please select a project first');
            return;
        }

        // Get command from user
        const command = await vscode.window.showInputBox({
            prompt: 'Enter command to run',
            placeHolder: 'python main.py',
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
            placeHolder: 'My Job from VS Code'
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
    const apiUrl = config.get<string>('apiUrl');
    
    // Load auto-refresh preference from configuration
    const autoRefreshEnabled = config.get<boolean>('autoRefreshEnabled', true);
    isAutoRefreshEnabled = autoRefreshEnabled;
    
    // API key is stored in memory only, so we're never authenticated on startup.
    // Always start unauthenticated and let the user re-authenticate.
    vscode.commands.executeCommand('setContext', 'domino:authenticated', false);
}

export function deactivate() {
    // Clean up auto-refresh timer
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = undefined;
    }
}

let dominoClient: DominoApiClient;
let projectProvider: ProjectProvider;
let jobProvider: JobProvider;
let workspaceProvider: WorkspaceProvider;

// Auto-refresh functionality
let autoRefreshTimer: NodeJS.Timeout | undefined;
let isAutoRefreshEnabled: boolean = true;
const AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

export function activate(context: vscode.ExtensionContext) {
    console.log('Domino Data Lab extension is now active!');
    
    // Log extension host type for debugging
    const extensionKind = vscode.extensions.getExtension('your-publisher-name.domino-datalab')?.extensionKind;
    console.log('Extension running in:', extensionKind === vscode.ExtensionKind.UI ? 'Local (UI)' : 'Remote (Workspace)');
    
    // Check if we're in a remote workspace
    const isRemote = vscode.env.remoteName !== undefined;
    console.log('Remote workspace detected:', isRemote, 'Remote name:', vscode.env.remoteName);

    // Initialize providers
    dominoClient = new DominoApiClient();
    projectProvider = new ProjectProvider(dominoClient);
    jobProvider = new JobProvider(dominoClient);
    workspaceProvider = new WorkspaceProvider(dominoClient);

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
        vscode.commands.registerCommand('domino.runJobWithFile', runJobWithFile)
    ];

    context.subscriptions.push(...commands);

    // Add auto-refresh timer to subscriptions for proper cleanup
    context.subscriptions.push({
        dispose: () => {
            if (autoRefreshTimer) {
                clearInterval(autoRefreshTimer);
                autoRefreshTimer = undefined;
            }
        }
    });

    // Check if already authenticated
    checkAuthentication();
}

// Auto-refresh functions


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
                
                const now = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
                vscode.window.setStatusBarMessage(`Domino: Last updated ${now}`, 5000);
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