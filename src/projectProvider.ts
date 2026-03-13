import * as vscode from 'vscode';
import { DominoApiClient } from './dominoApiClient';

type ProjectTreeItem = OwnerItem | ProjectItem;

export class ProjectProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ProjectTreeItem | undefined | null | void> = new vscode.EventEmitter<ProjectTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ProjectTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private projectsByOwner: Map<string, any[]> = new Map();

    constructor(private dominoClient: DominoApiClient) {}

    refresh(): void {
        this.projectsByOwner.clear();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ProjectTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ProjectTreeItem): Promise<ProjectTreeItem[]> {
        try {
            if (!element) {
                // Root level: fetch projects and group by owner
                const projects = await this.dominoClient.getProjects();
                this.projectsByOwner.clear();

                for (const project of projects) {
                    const owner = project.ownerUsername || 'Unknown';
                    if (!this.projectsByOwner.has(owner)) {
                        this.projectsByOwner.set(owner, []);
                    }
                    this.projectsByOwner.get(owner)!.push(project);
                }

                // Sort owners alphabetically
                const owners = Array.from(this.projectsByOwner.keys()).sort();
                return owners.map(owner => new OwnerItem(
                    owner,
                    this.projectsByOwner.get(owner)!.length
                ));
            }

            if (element instanceof OwnerItem) {
                // Child level: return projects for this owner
                const projects = this.projectsByOwner.get(element.ownerName) || [];
                return projects.map(project => new ProjectItem(
                    project.name,
                    project.description,
                    project.id,
                    vscode.TreeItemCollapsibleState.None,
                    project.ownerUsername
                ));
            }

            return [];
        } catch (error) {
            return [];
        }
    }
}

class OwnerItem extends vscode.TreeItem {
    constructor(
        public readonly ownerName: string,
        public readonly projectCount: number
    ) {
        super(ownerName, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `${projectCount} project${projectCount === 1 ? '' : 's'}`;
        this.tooltip = `Projects owned by ${ownerName}`;
        this.contextValue = 'owner';
        this.iconPath = new vscode.ThemeIcon('account');
    }
}

class ProjectItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly projectId: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly ownerUsername?: string
    ) {
        super(label, collapsibleState);
        this.tooltip = description;
        this.contextValue = 'project';
        this.iconPath = new vscode.ThemeIcon('folder');

        // Add command to select project when clicked
        this.command = {
            command: 'domino.selectProject',
            title: 'Select Project',
            arguments: [this] // Pass the project item itself
        };
    }
}
