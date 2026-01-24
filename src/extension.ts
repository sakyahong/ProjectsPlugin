import * as vscode from 'vscode';
import { ProjectsViewProvider } from './projectsViewProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ProjectsViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ProjectsViewProvider.viewType, provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.projects.addProject', () => {
            provider.addProject();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.projects.refresh', () => {
            provider.refresh();
        })
    );
}

export function deactivate() { }
