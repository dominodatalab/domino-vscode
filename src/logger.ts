import * as vscode from 'vscode';

// Centralized logging for the Domino extension.
//
// Every message is written to two places:
//   1. The VS Code Developer Console (Help > Toggle Developer Tools > Console),
//      via console.log / console.warn / console.error.
//   2. A dedicated "Domino" Output Channel (View > Output > Domino), which is
//      easier for end users to access and copy from than the dev tools.

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

let outputChannel: vscode.OutputChannel | undefined;

/**
 * Create the "Domino" output channel. Call once during activation.
 * Returns the channel so it can be pushed onto context.subscriptions.
 */
export function initLogger(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Domino');
    }
    return outputChannel;
}

function timestamp(): string {
    // Local time, millisecond precision, e.g. "14:23:05.123"
    return new Date().toISOString().slice(11, 23);
}

// Stringify an extra argument for the output channel without throwing on
// circular structures or dumping anything enormous.
function formatArg(arg: unknown): string {
    if (arg instanceof Error) {
        return arg.stack || `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === 'string') {
        return arg;
    }
    try {
        const json = JSON.stringify(arg);
        if (json === undefined) {
            return String(arg);
        }
        return json.length > 2000 ? json.slice(0, 2000) + '…(truncated)' : json;
    } catch {
        return String(arg);
    }
}

function write(level: LogLevel, message: string, args: unknown[]): void {
    const line = `[${timestamp()}] [${level}] ${message}`;

    // 1. Developer console — keep the structured args so they stay inspectable.
    const consoleArgs = args.length ? [line, ...args] : [line];
    switch (level) {
        case 'ERROR':
            console.error(...consoleArgs);
            break;
        case 'WARN':
            console.warn(...consoleArgs);
            break;
        default:
            console.log(...consoleArgs);
            break;
    }

    // 2. Output channel — flatten args to text.
    if (outputChannel) {
        const extra = args.length ? ' ' + args.map(formatArg).join(' ') : '';
        outputChannel.appendLine(line + extra);
    }
}

export const logger = {
    debug: (message: string, ...args: unknown[]) => write('DEBUG', message, args),
    info: (message: string, ...args: unknown[]) => write('INFO', message, args),
    warn: (message: string, ...args: unknown[]) => write('WARN', message, args),
    error: (message: string, ...args: unknown[]) => write('ERROR', message, args),
    /** Reveal the Domino output channel in the UI. */
    show: () => outputChannel?.show(),
};
