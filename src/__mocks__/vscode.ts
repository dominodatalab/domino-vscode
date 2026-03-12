export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2
}

export class TreeItem {
    label?: string;
    description?: string;
    tooltip?: any;
    iconPath?: any;
    contextValue?: string;
    command?: any;
    collapsibleState?: TreeItemCollapsibleState;

    constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
    }
}

export class ThemeIcon {
    constructor(public readonly id: string, public readonly color?: any) {}
}

export class ThemeColor {
    constructor(public readonly id: string) {}
}

export class MarkdownString {
    value: string;
    constructor(value = '') {
        this.value = value;
    }
}

export class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];

    readonly event = (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter(l => l !== listener);
            },
        };
    };

    fire(data?: T) {
        this.listeners.forEach(l => l(data as T));
    }

    dispose() {
        this.listeners = [];
    }
}

export class Uri {
    static parse(value: string) {
        return { toString: () => value, fsPath: value };
    }
}

export const env = {
    openExternal: jest.fn().mockResolvedValue(true),
};

export const window = {
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showQuickPick: jest.fn(),
    showInputBox: jest.fn(),
    createTerminal: jest.fn(),
};

export const workspace = {
    getConfiguration: jest.fn().mockReturnValue({
        get: jest.fn(),
    }),
};

export const commands = {
    executeCommand: jest.fn(),
    registerCommand: jest.fn(),
};
