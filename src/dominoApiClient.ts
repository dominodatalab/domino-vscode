import axios, { AxiosInstance, AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';

export class DominoApiClient {
    private httpClient: AxiosInstance | null = null;
    private _apiUrl: string = '';

    get apiUrl(): string {
        return this._apiUrl;
    }

    get apiHost(): string {
        try {
            return new URL(this._apiUrl).host;
        } catch {
            return this._apiUrl;
        }
    }

    get isAuthenticated(): boolean {
        return this.httpClient !== null && this.accessToken !== '';
    }
    private accessToken: string = '';
    public currentProjectId: string | null = null;
    public currentProjectName: string | null = null;
    private apiVersion: string = 'v4'; // Default, but will be detected
    private _currentUserId: string | null = null;

    async authenticate(apiUrl: string, accessToken: string): Promise<void> {
        this._apiUrl = apiUrl.replace(/\/$/, ''); // Remove trailing slash
        this.accessToken = accessToken;

        // Try to detect the correct API version
        await this.detectApiVersion();

        this.httpClient = axios.create({
            baseURL: `${this._apiUrl}/${this.apiVersion}`,
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });

        // Inject the current token on every request so that background token
        // refreshes are picked up immediately without recreating the client.
        this.httpClient.interceptors.request.use((config) => {
            config.headers['Authorization'] = `Bearer ${this.accessToken}`;
            return config;
        });

        // Test authentication
        await this.getProjects();
    }

    /** Update the Bearer token (used by background token refresh). */
    updateAccessToken(accessToken: string): void {
        this.accessToken = accessToken;
    }

    /** Reset all auth state (used on sign-out). */
    clearAuth(): void {
        this.httpClient = null;
        this.accessToken = '';
        this._apiUrl = '';
        this.currentProjectId = null;
        this.currentProjectName = null;
        this._currentUserId = null;
    }

    async getSelf(): Promise<{ id: string; userName: string }> {
        if (!this.httpClient) {
            throw new Error('Not authenticated');
        }
        if (this._currentUserId) {
            return { id: this._currentUserId, userName: '' };
        }
        const response = await this.httpClient.get('/users/self');
        this._currentUserId = response.data.id;
        return response.data;
    }

    private async detectApiVersion(): Promise<void> {
        const versions = ['v4', 'v1', 'v2', 'api/v1', 'api'];
        
        for (const version of versions) {
            try {
                const testClient = axios.create({
                    baseURL: `${this._apiUrl}/${version}`,
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                });

                await testClient.get('/projects');
                this.apiVersion = version;
                console.log(`Detected Domino API version: ${version}`);
                return;
            } catch (error) {
                const axiosError = error as AxiosError;
                console.log(`API version ${version} failed:`, axiosError.response?.status);
                continue;
            }
        }
        
        // Fallback to v4 if detection fails
        console.log('Could not detect API version, using v4 as fallback');
        this.apiVersion = 'v4';
    }

    async getProjects(): Promise<any[]> {
        if (!this.httpClient) {
            throw new Error('Not authenticated');
        }

        try {
            const response = await this.httpClient.get('/projects');
            return response.data;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Get projects error:', axiosError.response?.data || axiosError.message);
            throw error;
        }
    }

    async createProject(name: string, description?: string): Promise<any> {
        if (!this.httpClient) {
            throw new Error('Not authenticated');
        }

        const response = await this.httpClient.post('/projects', {
            name,
            description: description || ''
        });
        return response.data;
    }

    async setCurrentProject(projectId: string, projectName?: string): Promise<void> {
        this.currentProjectId = projectId;
        this.currentProjectName = projectName || null;
        console.log(`Set current project: ${projectId} (${projectName})`);
    }

    async getCurrentUser(): Promise<any> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            // Get project details to extract the owner username
            const endpoint = `/projects/${this.currentProjectId}`;
            console.log(`Getting project details from: ${endpoint}`);
            
            const response = await this.httpClient.get(endpoint);
            console.log('Project details response:', response.data);
            
            if (!response.data.ownerUsername) {
                throw new Error('No ownerUsername found in project details');
            }
            
            return {
                userName: response.data.ownerUsername,
                _projectDetails: response.data
            };
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Get current user (project owner) error:', axiosError.response?.data || axiosError.message);
            throw error;
        }
    }

    async getJobs(limit: number = 20, offset: number = 0): Promise<{jobs: any[], hasMore: boolean, total?: number}> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            // Domino API uses page_no for pagination and snake_case param names
            const pageNo = Math.floor(offset / limit) + 1;
            const params = new URLSearchParams({
                projectId: this.currentProjectId,
                page_size: limit.toString(),
                page_no: pageNo.toString(),
                order_by: 'number',
                sort_by: 'desc'
            });

            const endpoint = `/jobs/?${params.toString()}`;
            console.log(`Getting jobs from: ${endpoint}`);
            
            const response = await this.httpClient.get(endpoint);
            console.log('Jobs response:', {
                jobsReceived: response.data?.jobs?.length || 0,
                totalCount: response.data?.totalCount,
                pagination: response.data?.pagination,
                requestedPageSize: limit,
                actualLimit: response.data?.pagination?.limit
            });
            
            // Extract jobs from the response
            if (response.data) {
                const jobs = response.data.jobs || [];
                const total = response.data.totalCount || response.data.total || jobs.length;
                const hasMore = (offset + jobs.length) < total;
                
                console.log(`Found ${jobs.length} jobs (${offset + 1}-${offset + jobs.length} of ${total})`);
                
                return {
                    jobs,
                    hasMore,
                    total
                };
            } else {
                console.log('No jobs data found in response');
                return {
                    jobs: [],
                    hasMore: false,
                    total: 0
                };
            }
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Get jobs error:', axiosError.response?.data || axiosError.message);
            throw error;
        }
    }

    async runJob(command: string, title?: string, options?: {
        hardwareTierId?: string,
        environmentId?: string,
        commitId?: string
    }): Promise<any> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            // Get default configuration
            const config = await this.getJobConfiguration();
            
            // Build the job payload according to the API specification
            const jobPayload: any = {
                projectId: this.currentProjectId,
                commandToRun: command,
                title: title || 'VS Code Job',
                mainRepoGitRef: {
                    type: "branch",
                    value: "main" // or get from current git branch
                },
                // Optional parameters with sensible defaults
                externalVolumeMounts: [],
                netAppVolumeIds: [],
                snapshotDatasetsOnCompletion: false
            };

            // Use provided options or defaults, but only if they're not empty
            const environmentId = options?.environmentId || config.defaultEnvironment;
            if (environmentId && environmentId.trim() !== '') {
                jobPayload.environmentId = environmentId;
            }

            const hardwareTierId = options?.hardwareTierId || config.defaultHardwareTier;
            if (hardwareTierId && hardwareTierId.trim() !== '') {
                jobPayload.overrideHardwareTierId = hardwareTierId;
            }

            // Only add commitId if specified
            if (options?.commitId && options.commitId.trim() !== '') {
                jobPayload.commitId = options.commitId;
            }

            console.log('Job payload:', JSON.stringify(jobPayload, null, 2));

            // Use the updated endpoint
            const endpoint = `/jobs/start`;
            console.log(`Running job at: ${endpoint}`);
            
            const response = await this.httpClient.post(endpoint, jobPayload);
            console.log('Job response:', response.data);
            
            return response.data;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Run job error:', {
                status: axiosError.response?.status,
                statusText: axiosError.response?.statusText,
                data: axiosError.response?.data,
                message: axiosError.message
            });
            throw error;
        }
    }

    // Helper method to get job configuration from project settings
    private async getJobConfiguration(): Promise<{
        defaultHardwareTier: string,
        defaultEnvironment: string
    }> {
        try {
            // Get project settings to get the actual defaults
            const projectSettings = await this.getProjectSettings();
            
            console.log('Project settings:', projectSettings);

            return {
                defaultHardwareTier: projectSettings.defaultHardwareTierId || 'small-k8s',
                defaultEnvironment: projectSettings.defaultEnvironmentId || ''
            };
        } catch (error) {
            console.warn('Could not get project settings, using fallback defaults:', error);
            return {
                defaultHardwareTier: 'small-k8s',
                defaultEnvironment: ''
            };
        }
    }

    async getProjectSettings(): Promise<any> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            const endpoint = `/projects/${this.currentProjectId}/settings`;
            console.log(`Getting project settings from: ${endpoint}`);
            
            const response = await this.httpClient.get(endpoint);
            console.log('Project settings response:', response.data);
            
            return response.data;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Get project settings error:', axiosError.response?.data || axiosError.message);
            throw error;
        }
    }

    async getWorkspaces(): Promise<any[]> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            const self = await this.getSelf();

            // Add required query parameters
            const endpoint = `/workspace/project/${this.currentProjectId}/workspace?offset=0&limit=50`;
            console.log(`Getting workspaces from: ${endpoint}`);

            const response = await this.httpClient.get(endpoint);
            console.log('Workspaces response:', response.data);

            // Handle different response formats
            let workspaces: any[];
            if (response.data && Array.isArray(response.data)) {
                workspaces = response.data;
            } else if (response.data && response.data.workspaces) {
                workspaces = response.data.workspaces;
            } else if (response.data && response.data.data) {
                workspaces = response.data.data;
            } else {
                console.log('No workspaces array found in response');
                return [];
            }

            // Only show workspaces owned by the current user
            const ownedWorkspaces = workspaces.filter(ws => ws.ownerId === self.id);
            console.log(`Found ${workspaces.length} workspaces total, ${ownedWorkspaces.length} owned by current user`);
            return ownedWorkspaces;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Get workspaces error:', axiosError.response?.data || axiosError.message);
            return []; // Return empty array instead of throwing
        }
    }

    async commitWorkspace(workspaceId: string): Promise<any> {
        if (!this.httpClient || !this.currentProjectId || !this.currentProjectName) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            // First, get workspace details to extract execution-id
            const workspaceDetails = await this.getWorkspaceDetails(workspaceId);
            
            const executionId = workspaceDetails.mostRecentSession?.executionId || workspaceDetails.executionId;
            if (!executionId) {
                throw new Error('No execution-id found in workspace details');
            }

            // Get current user information
            const currentUser = await this.getCurrentUser();
            if (!currentUser.userName) {
                throw new Error('Unable to determine current username');
            }

            // Build the new endpoint format: /u/<USERNAME>/<project-NAME>/run/synchronizeRunWorkingDirectory/<run-id>
            const directUrl = `${this._apiUrl}/u/${currentUser.userName}/${this.currentProjectName}/run/synchronizeRunWorkingDirectory/${executionId}`;
            console.log(`Committing workspace at: ${directUrl}`);
            
            const requestBody = {
                uploadLocalChanges: true,
                shouldSaveConflicts: false,
                syncOperationInfo: {
                    syncOperationId: "3db163c8-6400-4a31-b040-000000000001",
                    syncOperationType: "onlyDfs"
                }
            };
            
            const response = await axios.post(directUrl, requestBody, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
            
            console.log('Workspace commit successful');
            return response.data;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Commit workspace error details:', {
                status: axiosError.response?.status,
                statusText: axiosError.response?.statusText,
                data: axiosError.response?.data,
                message: axiosError.message
            });
            throw error;
        }
    }

    async stopWorkspace(workspaceId: string): Promise<void> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            const endpoint = `/workspace/project/${this.currentProjectId}/workspace/${workspaceId}/stop`;
            console.log(`Stopping workspace at: ${endpoint}`);
            
            await this.httpClient.post(endpoint);
            console.log('Workspace stop request sent successfully');
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Stop workspace error:', axiosError.response?.data || axiosError.message);
            throw error;
        }
    }

    async startWorkspace(workspaceId: string): Promise<any> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            // First, get the workspace details to use its existing configuration
            const workspaces = await this.getWorkspaces();
            const workspace = workspaces.find(ws => ws.id === workspaceId);
            
            if (!workspace) {
                throw new Error('Workspace not found');
            }

            const endpoint = `/workspace/project/${this.currentProjectId}/workspace/${workspaceId}/sessions?externalVolumeMounts=`;
            console.log(`Starting workspace at: ${endpoint}`);
            
            // Use the existing workspace configuration, especially the mounts
            const requestBody = {
                externalVolumeMounts: workspace.mostRecentSession?.externalVolumeMounts || [],
                netAppVolumeMounts: workspace.mostRecentSession?.netAppVolumeMounts || [],
                datasetMounts: workspace.mostRecentSession?.datasetMounts || [],
                importedProjects: workspace.importedProjects || [],
                importedGitRepos: workspace.importedGitRepos || []
            };
            
            console.log('Start workspace request body:', requestBody);
            
            const response = await this.httpClient.post(endpoint, requestBody);
            console.log('Workspace start response:', response.data);
            return response.data;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Start workspace error:', axiosError.response?.data || axiosError.message);
            throw error;
        }
    }

    async getWorkspaceDetails(workspaceId: string): Promise<any> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            // Use the correct endpoint format
            const endpoint = `/workspace/project/${this.currentProjectId}/workspace/${workspaceId}`;
            console.log(`Getting workspace details from: ${endpoint}`);
            
            const response = await this.httpClient.get(endpoint);
            console.log('Workspace details response:', response.data);
            return response.data;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Get workspace details error:', axiosError.response?.data || axiosError.message);
            throw error;
        }
    }

    async getHardwareTiers(): Promise<any[]> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            // Try multiple possible endpoints
            const endpoints = [
                `/projects/${this.currentProjectId}/hardwareTiers`
            ];

            for (const endpoint of endpoints) {
                try {
                    const response = await this.httpClient.get(endpoint);
                    console.log(`Hardware tiers from ${endpoint}:`, response.data);
                    
                    if (Array.isArray(response.data)) {
                        // Transform the nested structure to a flat structure for easier use
                        const transformedTiers = response.data.map(item => {
                            const tier = item.hardwareTier || item; // Handle both nested and flat structures
                            
                            return {
                                id: tier.id,
                                name: tier.name,
                                description: tier.description || '',
                                // Extract CPU and memory from the nested hwtResources structure
                                cpu: tier.hwtResources?.cores || tier.cores || 'N/A',
                                memory: tier.hwtResources?.memory?.value || tier.memory?.value || tier.memory || 'N/A',
                                memoryUnit: tier.hwtResources?.memory?.unit || tier.memory?.unit || 'GiB',
                                // Include GPU info if available
                                gpus: tier.gpuConfiguration?.numberOfGpus || 0,
                                // Include flags for additional info
                                isDefault: tier.hwtFlags?.isDefault || false,
                                isVisible: tier.hwtFlags?.isVisible !== false, // Default to visible if not specified
                                // Include the full original object for reference
                                _original: tier
                            };
                        }).filter(tier => tier.isVisible); // Only show visible tiers
                        
                        console.log('Transformed hardware tiers:', transformedTiers);
                        return transformedTiers;
                    }
                    return [];
                } catch (error) {
                    const axiosError = error as AxiosError;
                    if (axiosError.response?.status === 404) {
                        continue; // Try next endpoint
                    }
                    throw error; // Re-throw non-404 errors
                }
            }

            // If no endpoint works, return a default set
            console.warn('No hardware tiers endpoint found, returning defaults');
            return [
                { 
                    id: 'small-k8s', 
                    name: 'Small', 
                    description: 'Small tier',
                    cpu: '1',
                    memory: '4',
                    memoryUnit: 'GiB',
                    gpus: 0,
                    isDefault: true,
                    isVisible: true
                },
                { 
                    id: 'medium-k8s', 
                    name: 'Medium', 
                    description: 'Medium tier',
                    cpu: '4',
                    memory: '15',
                    memoryUnit: 'GiB',
                    gpus: 0,
                    isDefault: false,
                    isVisible: true
                },
                { 
                    id: 'large-k8s', 
                    name: 'Large', 
                    description: 'Large tier',
                    cpu: '6',
                    memory: '27',
                    memoryUnit: 'GiB',
                    gpus: 0,
                    isDefault: false,
                    isVisible: true
                }
            ];
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Get hardware tiers error:', axiosError.response?.data || axiosError.message);
            return [
                { 
                    id: 'small-k8s', 
                    name: 'Small', 
                    description: 'Small tier',
                    cpu: '1',
                    memory: '4',
                    memoryUnit: 'GiB',
                    gpus: 0,
                    isDefault: true,
                    isVisible: true
                }
            ];
        }
    }

    async getEnvironments(): Promise<any[]> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            // Try multiple possible endpoints
            const endpoints = [
                `/projects/${this.currentProjectId}/useableEnvironments`,
                '/environments',
                '/compute-environments',
                '/computeEnvironments'
            ];

            for (const endpoint of endpoints) {
                try {
                    const response = await this.httpClient.get(endpoint);
                    console.log(`Environments from ${endpoint}:`, response.data);
                    
                    // Handle the useableEnvironments response format
                    if (response.data && (response.data.environments || response.data.currentlySelectedEnvironment)) {
                        const environments = [];
                        
                        // Add the currently selected environment first (as default)
                        if (response.data.currentlySelectedEnvironment) {
                            const currentEnv = response.data.currentlySelectedEnvironment;
                            environments.push({
                                id: currentEnv.id,
                                name: currentEnv.name,
                                description: currentEnv.description || '',
                                version: currentEnv.v2EnvironmentDetails?.selectedRevision || currentEnv.version || 'N/A',
                                visibility: currentEnv.visibility || 'Unknown',
                                isCurated: currentEnv.isCurated || false,
                                isDefault: true, // Mark as default
                                isCurrentlySelected: true,
                                archived: currentEnv.archived || false, // Include archived property
                                _original: currentEnv
                            });
                        }
                        
                        // Add other available environments
                        if (response.data.environments && Array.isArray(response.data.environments)) {
                            response.data.environments.forEach((env: any) => {
                                // Don't duplicate the currently selected environment
                                if (!response.data.currentlySelectedEnvironment || 
                                    env.id !== response.data.currentlySelectedEnvironment.id) {
                                    environments.push({
                                        id: env.id,
                                        name: env.name,
                                        description: env.description || '',
                                        version: env.activeRevisionNumber || env.version || 'N/A',
                                        visibility: env.visibility || 'Unknown',
                                        isCurated: env.isCurated || false,
                                        isDefault: false,
                                        isCurrentlySelected: false,
                                        archived: env.archived || false, // Include archived property in transformed object
                                        _original: env
                                    });
                                }
                            });
                        }
                        
                        // Filter out archived environments
                        const activeEnvironments = environments.filter(env => !env.archived);
                        
                        console.log('Transformed environments:', activeEnvironments);
                        return activeEnvironments;
                    }
                    
                    // Handle simple array response format (fallback)
                    if (Array.isArray(response.data)) {
                        const transformedEnvs = response.data.map((env: any) => ({
                            id: env.id,
                            name: env.name,
                            description: env.description || '',
                            version: env.version || 'N/A',
                            visibility: env.visibility || 'Unknown',
                            isCurated: env.isCurated || false,
                            isDefault: false,
                            isCurrentlySelected: false,
                            archived: env.archived || false, // Include archived property
                            _original: env
                        })).filter((env: any) => !env.archived); // Filter out archived environments
                        
                        console.log('Transformed environments (simple array):', transformedEnvs);
                        return transformedEnvs;
                    }
                    
                    return [];
                } catch (error) {
                    const axiosError = error as AxiosError;
                    if (axiosError.response?.status === 404) {
                        continue; // Try next endpoint
                    }
                    throw error; // Re-throw non-404 errors
                }
            }

            // If no endpoint works, return empty array (environment is optional)
            console.warn('No environments endpoint found, returning empty array');
            return [];
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Get environments error:', axiosError.response?.data || axiosError.message);
            return [];
        }
    }

    async getAvailableToolsForEnvironment(environmentId: string): Promise<any[]> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            const endpoint = `/workspaces/project/${this.currentProjectId}/environment/${environmentId}/availableTools`;
            console.log(`Getting available tools from: ${endpoint}`);

            const response = await this.httpClient.get(endpoint);
            console.log('Available tools response:', response.data);

            if (response.data && response.data.workspaceTools) {
                return response.data.workspaceTools.map((tool: any) => ({
                    id: tool.id,
                    name: tool.name,
                    title: tool.title,
                    iconUrl: tool.iconUrl || null
                }));
            }
            return [];
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Get available tools error:', axiosError.response?.data || axiosError.message);
            throw error;
        }
    }

    async createWorkspace(
        name: string,
        environmentId: string,
        hardwareTierId: string,
        tools: string[]
    ): Promise<any> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            const endpoint = `/workspace/project/${this.currentProjectId}/workspace`;
            console.log(`Creating workspace at: ${endpoint}`);

            const requestBody = {
                name: name,
                environmentId: environmentId,
                hardwareTierId: { value: hardwareTierId },
                tools: tools,
                externalVolumeMounts: [],
                ssh: { enabled: true }
            };

            console.log('Create workspace payload:', JSON.stringify(requestBody, null, 2));

            const response = await this.httpClient.post(endpoint, requestBody);
            console.log('Create workspace response:', response.data);
            return response.data;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Create workspace error:', {
                status: axiosError.response?.status,
                statusText: axiosError.response?.statusText,
                data: axiosError.response?.data,
                message: axiosError.message
            });
            throw error;
        }
    }

    async syncFiles(localPath: string): Promise<void> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        // This is a simplified implementation
        const files = this.getFilesRecursively(localPath);
        
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', fs.createReadStream(file));
            formData.append('path', path.relative(localPath, file));

            try {
                await this.httpClient.post(`/projects/${this.currentProjectId}/files`, formData, {
                    headers: formData.getHeaders()
                });
            } catch (error) {
                const axiosError = error as AxiosError;
                console.error(`Failed to upload ${file}:`, axiosError.response?.data || axiosError.message);
            }
        }
    }

    async downloadFiles(targetPath: string): Promise<void> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        // Simplified implementation
        const response = await this.httpClient.get(`/projects/${this.currentProjectId}/files/archive`);
        
        // Extract and save files to targetPath
        // This would require a proper zip extraction implementation
    }

    async deployModel(modelFile: string, modelName: string): Promise<any> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        const response = await this.httpClient.post(`/projects/${this.currentProjectId}/models`, {
            name: modelName,
            file: modelFile
        });
        return response.data;
    }

    async getModels(): Promise<any[]> {
        if (!this.httpClient || !this.currentProjectId) {
            throw new Error('Not authenticated or no project selected');
        }

        try {
            const response = await this.httpClient.get(`/projects/${this.currentProjectId}/models`);
            return response.data;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error('Get models error:', axiosError.response?.data || axiosError.message);
            return []; // Return empty array instead of throwing
        }
    }

    private getFilesRecursively(dir: string): string[] {
        const files: string[] = [];
        const items = fs.readdirSync(dir);

        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                // Skip node_modules, .git, etc.
                if (!item.startsWith('.') && item !== 'node_modules') {
                    files.push(...this.getFilesRecursively(fullPath));
                }
            } else {
                files.push(fullPath);
            }
        }

        return files;
    }
}