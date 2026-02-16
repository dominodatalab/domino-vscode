import * as vscode from 'vscode';
import { DominoApiClient } from './dominoApiClient';

export class ProjectProvider implements vscode.TreeDataProvider<ProjectItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ProjectItem | undefined | null | void> = new vscode.EventEmitter<ProjectItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ProjectItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private dominoClient: DominoApiClient) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ProjectItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ProjectItem): Promise<ProjectItem[]> {
        try {
            const projects = await this.dominoClient.getProjects();
            return projects.map(project => new ProjectItem(
                project.name,
                project.description,
                project.id,
                vscode.TreeItemCollapsibleState.None
            ));
        } catch (error) {
            return [];
        }
    }
}

class ProjectItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly projectId: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
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