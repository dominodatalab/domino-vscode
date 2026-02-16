# Domino Data Lab VS Code Extension

This extension provides mechanisms to manage jobs and workspaces in your Domino Data Lab deployment.

## Features

### Authentication & Connection
- Secure API key-based authentication with Domino instance

### Project Management
- Create new projects directly from VS Code
- View project details and ownership information
- Automatic project switching with context updates

### Job Execution & Monitoring
- **Run Custom Jobs**: Execute any command with hardware/environment selection
- **File-Based Jobs**: Right-click any file to run it as a Domino job
- **Real-time Monitoring**: Track job status with auto-refresh
- **Pagination Support**: Browse through large job histories
- **Browser Integration**: Open job results directly in Domino UI

### Workspace Management
- Start and stop workspaces with one click
- Commit workspace changes to project repository
- Open workspaces directly in browser
- Monitor workspace status and resource usage

## Usage

### First Time Setup
1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **"Domino: Authenticate with Domino"**
3. Enter your Domino instance URL (e.g., `https://your-domino-instance.com`)
4. Enter your Domino API key

### Select a Project
```
Sidebar: "Domino Projects" → Click on project name
OR Command Palette → "Domino: Select Project"
```

### Run Your First Job
```
Option A: Right-click any Python/R file → "Run with Domino"
Option B: Command Palette → "Domino: Run Job" → Enter command
```

This will default to the project defaults but allows you to override things such as hardware tier and compute environment

### Start a Workspace
```
Sidebar: "Domino Workspaces" → Click ▶️ next to workspace
OR Command Palette → "Domino: Start Workspace"
```

## Use Cases

### SSHable workspaces
With Dominos SSHable workspaces, you're now able to SSH directly into a Domino workspace from your local VS Code IDE using the [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension.

Rather than going back and forth between IDE and browser, you can use this extension to sync files back into your workspace.

## Support

For issues and questions:
- Submit issues via repository issue tracker

