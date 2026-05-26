# Domino Data Lab — VS Code Extension

Manage Domino Data Lab jobs and workspaces without leaving your IDE. Authenticate once, browse your projects, launch and monitor jobs, and connect directly to remote workspaces over SSH.

[![Install from VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=DominoDataLab.domino-data-lab-vscode-extension)
[![Install from Open VSX](https://img.shields.io/badge/Open%20VSX-Install-purple?logo=eclipse)](https://open-vsx.org/extension/DominoDataLab/domino-data-lab-vscode-extension)

---

## Installation

| Marketplace | Link |
|---|---|
| **VS Code Marketplace** (Azure) | [DominoDataLab.domino-data-lab-vscode-extension](https://marketplace.visualstudio.com/items?itemName=DominoDataLab.domino-data-lab-vscode-extension) |
| **Open VSX Registry** | [DominoDataLab/domino-data-lab-vscode-extension](https://open-vsx.org/extension/DominoDataLab/domino-data-lab-vscode-extension) |

---

## Features

- **Connect to workspaces via SSH** — open a Remote-SSH window directly into a running Domino workspace
- **Run jobs** — submit any file or custom command as a Domino job, with hardware tier and environment selection
- **Manage projects** — browse, create, and switch projects from the sidebar
- **Monitor workspaces & jobs** — real-time status with auto-refresh, pagination, and browser integration

---

## Connect to Workspace

The headline feature of this extension is the ability to SSH directly into a running Domino workspace from VS Code, using the [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension.

> **Prerequisite:** The `dom` CLI must be installed and available on your `PATH`.

### How it works

1. Start a workspace from the **Domino Workspaces** sidebar panel (or the Command Palette).
2. Once the workspace is running, right-click it and select **Connect SSH Tunnel**.
3. The extension runs `dom connect` to establish an SSH tunnel to the workspace and automatically adds an entry to your `~/.ssh/config`.
4. A new VS Code Remote-SSH window opens, connected to your workspace at `/mnt` by default.

To disconnect, right-click the workspace and select **Disconnect SSH Tunnel**. The extension kills the tunnel process and cleans up the SSH config entry.

### Background proxy mode

By default the SSH tunnel runs in a visible VS Code terminal. Enable `domino.sshBackgroundProxy` to run the tunnel as a detached background process — it will survive VS Code being closed, and the extension will automatically reconnect on restart.

```jsonc
// settings.json
{
  "domino.sshBackgroundProxy": true
}
```

Tunnel logs are written to `~/.domino/vscode-extension/logs/<workspaceId>.log`.

### Custom SSH username (RHEL / UBI8 environments)

By default the extension connects as `ubuntu`, which is correct for standard Domino Ubuntu-based compute environments. If your organisation uses **RHEL or UBI8-based images** (where the workspace user is `domino` rather than `ubuntu`), set `domino.sshUser` to match:

```jsonc
// settings.json
{
  "domino.sshUser": "domino"
}
```

This setting controls the username in all SSH-related code paths: the `dom connect -l` flag, the `User` field written to `~/.ssh/config`, and the SSH command shown in workspace tooltips and the copy-to-clipboard action. The default is `ubuntu`, so existing Ubuntu-based environments require no change.

---

## Getting Started

### 1. Authenticate

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **Domino: Authenticate with Domino**. Enter your Domino instance URL and API key.

You can pre-configure the URL to skip the prompt:

```jsonc
// settings.json
{
  "domino.apiUrl": "https://your-domino-instance.com"
}
```

### 2. Select a project

Click a project in the **Domino Projects** sidebar panel, or run **Domino: Select Project** from the Command Palette. A project must be selected before you can interact with jobs or workspaces.

### 3. Run a job

- **Right-click** any Python, R, Notebook, shell, or JS/TS file and choose **Run with Domino**
- **Command Palette** → **Domino: Run Job** to enter a custom command

Both options let you override the hardware tier and compute environment before submitting.

### 4. Start a workspace

In the **Domino Workspaces** panel click the play button next to any workspace, or run **Domino: Start Workspace** from the Command Palette.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `domino.apiUrl` | _(empty)_ | Domino instance URL. Set to skip the URL prompt on sign-in. |
| `domino.oauthClientId` | `domino-connect-client` | Keycloak OAuth2 client ID. Contact your admin if the default doesn't work. |
| `domino.autoRefreshEnabled` | `true` | Enable auto-refresh of jobs and workspaces. |
| `domino.autoRefreshInterval` | `30000` | Refresh interval in milliseconds (5,000–300,000). |
| `domino.sshAutoConnect` | `true` | Automatically open a Remote-SSH window after the tunnel is established. |
| `domino.sshBackgroundProxy` | `false` | Run the SSH proxy as a background process independent of VS Code. |
| `domino.sshIdentityFile` | `~/.domino/host_keys/id_ecdsa` | Path to the SSH private key used for workspace connections. |
| `domino.sshUser` | `ubuntu` | SSH username for workspace connections. Set to `domino` for RHEL/UBI8-based compute environments. |
| `domino.workspaceDefaultDirectory` | `/mnt` | Working directory used when opening a Remote-SSH window. |

---

## Support

- **Bug reports & feature requests:** [GitHub Issues](https://github.com/dominodatalab/domino-vscode/issues)
- **Domino documentation:** [docs.dominodatalab.com](https://docs.dominodatalab.com)
