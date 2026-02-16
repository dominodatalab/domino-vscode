# Domino Data Lab VS Code Extension - Available Commands

This document provides a comprehensive overview of all available commands in the Domino Data Lab VS Code extension, their inputs, and usage.

## 🔐 Authentication Commands

### `domino.authenticate`
**Title:** Authenticate with Domino
**Input Required:** 
- API URL (e.g., `https://your-domino-instance.com`)
- API Key (from your Domino user settings)
**Description:** Establishes connection to your Domino Data Lab instance. This must be done first before using any other commands.

---

## 📁 Project Management Commands

### `domino.selectProject`
**Title:** Select Project
**Input Required:** Project selection from list
**Description:** Sets the active project for all subsequent operations. Projects are displayed with ID and name.

### `domino.createProject`
**Title:** Create New Project
**Input Required:** 
- Project name
- Project description (optional)
**Description:** Creates a new project in your Domino instance.

### `domino.refreshProjects`
**Title:** Refresh Projects
**Input Required:** None
**Description:** Refreshes the projects list in the sidebar.

---

## 🏃 Job Management Commands

### `domino.runJob`
**Title:** Run Job
**Input Required:**
- Command to execute (e.g., `python main.py`)
- Job title (optional)
- Hardware tier selection (optional)
- Environment selection (optional)
**Description:** Executes a job in the selected project with the specified command.

### `domino.runJobWithFile`
**Title:** Run Job with File
**Input Required:**
- File must be selected in explorer (.py, .r, .R, .ipynb)
- Additional command parameters (optional)
**Context:** Available via right-click context menu on supported files
**Description:** Runs a job using the selected file as the main script.

### `domino.viewJobs`
**Title:** View Jobs
**Input Required:** None
**Description:** Opens a webview panel showing recent jobs with detailed information and pagination.

### `domino.loadMoreJobs`
**Title:** Load More Jobs
**Input Required:** None
**Context:** Available in jobs webview panel
**Description:** Loads additional jobs in the jobs panel (pagination).

### `domino.startJobFromPanel`
**Title:** Start Job from Panel
**Input Required:** Command input from jobs panel
**Context:** Available in jobs webview panel
**Description:** Starts a new job directly from the jobs panel interface.

### `domino.openJobInBrowser`
**Title:** Open Job in Browser
**Input Required:** Job selection from jobs tree
**Context:** Available via right-click on job items
**Description:** Opens the selected job in your default browser within the Domino interface.

### `domino.refreshJobs`
**Title:** Refresh Jobs
**Input Required:** None
**Description:** Refreshes the jobs list in the sidebar.

---

## 💻 Workspace Management Commands

### `domino.startWorkspace`
**Title:** Start Workspace
**Input Required:** Workspace selection from list
**Context:** Available on stopped workspaces
**Description:** Starts a stopped workspace, making it available for use.

### `domino.stopWorkspace`
**Title:** Stop Workspace
**Input Required:** Workspace selection from list
**Context:** Available on running workspaces
**Description:** Stops a running workspace to free up resources.

### `domino.openWorkspace`
**Title:** Open Workspace
**Input Required:** Workspace selection from list
**Context:** Available on running workspaces
**Description:** Opens the workspace in your default browser within the Domino interface.

### `domino.commitWorkspace`
**Title:** Commit Workspace
**Input Required:** Workspace selection from list
**Context:** Available on running workspaces
**Description:** Commits changes from the workspace back to the project repository. No commit message required.

### `domino.refreshWorkspaces`
**Title:** Refresh Workspaces
**Input Required:** None
**Description:** Refreshes the workspaces list in the sidebar.

---

## ⚙️ Auto-Refresh Commands

### `domino.toggleAutoRefresh`
**Title:** Toggle Auto Refresh
**Input Required:** None
**Description:** Toggles automatic refreshing of jobs and workspaces (30-second intervals).

### `domino.enableAutoRefresh`
**Title:** Enable Auto Refresh
**Input Required:** None
**Description:** Enables automatic refreshing of data.

### `domino.disableAutoRefresh`
**Title:** Disable Auto Refresh
**Input Required:** None
**Description:** Disables automatic refreshing to reduce API calls.

---

## 🎯 Command Access Methods

### Command Palette
Access all commands via `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux) and type "Domino" to see available commands.

### Sidebar Tree Views
- **Projects:** Right-click for project-specific commands
- **Jobs:** Right-click for job management commands  
- **Workspaces:** Right-click for workspace management commands

### Context Menus
- **File Explorer:** Right-click on `.py`, `.r`, `.R`, or `.ipynb` files for "Run Job with File"

### Inline Actions
- Toolbar buttons in tree views for common actions like refresh, start/stop, etc.

---

## 📋 Required Prerequisites

1. **Domino API Key:** Generate from your Domino user settings
2. **Network Access:** VS Code must be able to reach your Domino instance
3. **Authentication:** Must run `domino.authenticate` before using other commands
4. **Project Selection:** Must select a project before running jobs or managing workspaces

---

## 🔄 Typical Workflow

1. **Authenticate:** Run `domino.authenticate` with your API URL and key
2. **Select Project:** Use `domino.selectProject` to choose your working project
3. **Manage Resources:** Use job and workspace commands as needed
4. **Auto-refresh:** Enable `domino.enableAutoRefresh` for real-time updates

---

## 📊 Data Inputs and Outputs

### Jobs
- **Input:** Command strings, hardware tiers, environments, file paths
- **Output:** Job execution results, logs, browser links

### Workspaces  
- **Input:** Workspace IDs, session configurations
- **Output:** Workspace status, browser access, commit confirmations

### Projects
- **Input:** Project names, descriptions
- **Output:** Project listings, selection confirmations

All commands provide appropriate success/error messages and integrate with VS Code's notification system.
