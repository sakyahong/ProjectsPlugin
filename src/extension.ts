import * as vscode from 'vscode';
import { ProjectsViewProvider } from './projectsViewProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ProjectsViewProvider(context.extensionUri, context);

    // One-time cleanup of old project configurations
    context.globalState.update('antigravity.projects', undefined);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ProjectsViewProvider.viewType, provider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
    );





    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.projects.clearCache', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Are you sure you want to clear all Projects Plugin cache? This will remove all added projects.',
                'Yes', 'No'
            );

            if (answer === 'Yes') {
                await context.globalState.update('antigravity.projects', undefined);
                await context.globalState.update('pendingOpenConversation', undefined);
                vscode.window.showInformationMessage('Projects Plugin cache cleared. Reloading window...');
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
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
