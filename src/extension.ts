import * as vscode from 'vscode';
import { ProjectsViewProvider } from './projectsViewProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ProjectsViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ProjectsViewProvider.viewType, provider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
    );

    // Auto-focus view on startup
    setTimeout(() => {
        vscode.commands.executeCommand('antigravity.projectsView.focus');
    }, 100);

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.projects.addProject', () => {
            provider.addProject();
        })
    );


    // Check for pending conversation to open (after window reload/project switch)
    const pendingChat = context.globalState.get<{ id: string, timestamp: number }>('pendingOpenConversation');
    if (pendingChat) {
        // Clear immediately
        context.globalState.update('pendingOpenConversation', undefined);

        // Only open if recent (e.g. within 5 mins)
        if (Date.now() - pendingChat.timestamp < 5 * 60 * 1000) {
            setTimeout(() => {
                vscode.commands.executeCommand('antigravity.setVisibleConversation', pendingChat.id);
            }, 1500); // Small delay to ensure UI is ready
        }
    }
}

export function deactivate() { }
