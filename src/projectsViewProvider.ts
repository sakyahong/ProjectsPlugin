import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectStore } from './projectStore';
import { SessionParser } from './sessionParser';
import { Project, Session, Conversation } from './types';
import { PortDetector } from './services/portDetector';
import { QuotaService, GroupedQuota } from './services/quotaService';
import { ConversationService } from './services/conversationService';
import { SkillService } from './services/skillService';

export class ProjectsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'antigravity.projectsView';
    private _view?: vscode.WebviewView;
    private projectStore: ProjectStore;
    private sessionParser: SessionParser;
    private portDetector: PortDetector;
    private quotaService: QuotaService;
    private conversationService: ConversationService;
    private skillService: SkillService;
    private quotaTimer?: NodeJS.Timeout;
    private cachedPort?: number;
    private cachedCsrfToken?: string;

    private conversationTimer?: NodeJS.Timeout;
    private autoSyncTimer?: NodeJS.Timeout;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext
    ) {
        this.projectStore = new ProjectStore(context);
        this.sessionParser = new SessionParser();
        this.portDetector = new PortDetector();
        this.quotaService = new QuotaService();
        this.conversationService = new ConversationService();
        this.skillService = new SkillService();

        // Live Watcher for Skills is now handled by refreshWatchers() per project

        // Polling for Conversations (every 30s)
        this.conversationTimer = setInterval(() => {
            this.fetchAndSendConversations();
        }, 30000);

        // Auto-sync for projects (every 10s) to detect changes from other windows
        this.autoSyncTimer = setInterval(() => {
            this.checkAndRefreshIfProjectsChanged();
        }, 10000);

        context.subscriptions.push({
            dispose: () => {
                if (this.conversationTimer) clearInterval(this.conversationTimer);
                if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
                this.fileWatchers.forEach(w => w.dispose());
            }
        });

        // Listen for workspace changes to update active project
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())
        );
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'openProject':
                    if (data.path) {
                        const uri = vscode.Uri.file(data.path);
                        const forceNewWindow = !!data.newWindow;
                        vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: forceNewWindow });
                        this.projectStore.updateLastOpened(data.id);
                    }
                    break;
                case 'handleChatClick':
                    if (data.cascadeId && data.projectPath) {
                        this.handleChatRequest(data.cascadeId, data.projectPath);
                    }
                    break;
                case 'deleteProject':
                    if (data.id) {
                        await this.projectStore.deleteProject(data.id);
                        this.refresh();
                    }
                    break;
                case 'openFile':
                    if (data.path) {
                        const uri = vscode.Uri.file(data.path);
                        vscode.commands.executeCommand('vscode.open', uri);
                    }
                    break;
                case 'refresh':
                case 'onLoad':
                    this.refresh();
                    this.initQuotaFetching();
                    break;
            }
        });
    }

    private async handleChatRequest(cascadeId: string, projectPath: string) {
        // Normalize paths for comparison
        const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase();
        // Remove file:// prefix based on OS if needed, but usually fsPath has it removed.
        // However, projectPath comes from storage which might have file://
        const targetPath = projectPath.replace(/^file:\/\//, '').toLowerCase();

        if (currentWorkspace === targetPath) {
            // Same project, just open chat
            vscode.commands.executeCommand('antigravity.setVisibleConversation', cascadeId);
        } else {
            // Different project, prompt user
            const action = await vscode.window.showQuickPick(
                ['Open Project in Current Window & Chat', 'Open Project in New Window & Chat'],
                { placeHolder: 'This chat belongs to a different project.' }
            );

            if (!action) return;

            const uri = vscode.Uri.file(targetPath);

            if (action.includes('New Window')) {
                vscode.commands.executeCommand('vscode.openFolder', uri, true);
            } else {
                // Switch Window (Reloads extension)
                // Persist pending chat
                await this.context.globalState.update('pendingOpenConversation', {
                    id: cascadeId,
                    timestamp: Date.now()
                });
                vscode.commands.executeCommand('vscode.openFolder', uri, false);
            }
        }
    }

    private async initQuotaFetching() {
        try {
            const processInfo = await this.portDetector.detect();
            if (processInfo) {
                // Cache port and token for conversation fetching
                this.cachedPort = processInfo.connectPort;
                this.cachedCsrfToken = processInfo.csrfToken;

                this.fetchAndSendQuota();

                // Poll every 5 seconds
                if (this.quotaTimer) clearInterval(this.quotaTimer);
                this.quotaTimer = setInterval(() => this.fetchAndSendQuota(), 5000);
            } else {
                // console.log('Antigravity language server process not found.');
            }
        } catch (error) {
            console.error('Failed to initialize quota fetching:', error);
        }
    }

    public refreshQuota() {
        if (this.quotaService && this._view) {
            this.fetchAndSendQuota();
        }
    }

    private async fetchAndSendQuota() {
        if (!this.quotaService || !this._view || !this.cachedPort || !this.cachedCsrfToken) return;

        try {
            const rawData = await this.quotaService.getUserStatus(this.cachedPort, this.cachedCsrfToken);
            const groupedQuotas = this.quotaService.processQuotaResponse(rawData);

            // Transform to UI format
            const uiGroups = groupedQuotas.map(g => ({
                id: g.groupId,
                name: g.groupName,
                remaining: g.remaining,
                limit: g.limit,
                resetDate: g.resetDate,
                models: g.models.map(m => ({
                    id: m.modelName.replace(/\s+/g, '-').toLowerCase(),
                    name: m.modelName,
                    remaining: m.remaining,
                    limit: m.limit,
                    resetDate: m.resetDate
                }))
            }));

            this._view.webview.postMessage({
                type: 'usageUpdate',
                groups: uiGroups
            });
        } catch (error: any) {
            // Suppress initialization error as it's transient
            if (error.message && error.message.includes('LanguageServerClient must be initialized first')) {
                return;
            }
            console.error('Failed to fetch quota:', error);
        }
    }

    private async fetchAndSendConversations(projectPath?: string) {
        // ... (detection logic)
        if (!this.cachedPort || !this.cachedCsrfToken) {
            try {
                const processInfo = await this.portDetector.detect();
                if (processInfo) {
                    this.cachedPort = processInfo.connectPort;
                    this.cachedCsrfToken = processInfo.csrfToken;
                } else {
                    return null; // Return null if not ready
                }
            } catch (error) {
                console.error('Failed to detect port:', error);
                return null;
            }
        }

        if (!this._view) return null;

        try {
            const allConversations = await this.conversationService.fetchConversations(
                this.cachedPort,
                this.cachedCsrfToken
            );

            // Fetch details in background (asynchronously)
            if (allConversations.length > 0) {
                this.enrichConversationsWithWorkspace(allConversations);
            }

            return allConversations;
        } catch (error) {
            console.error('Failed to fetch conversations:', error);
            return [];
        }
    }

    public async addProject() {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Project'
        });

        if (result && result[0]) {
            const projectPath = result[0].fsPath;
            const projectName = result[0].path.split('/').pop() || 'Untitled';

            // Check duplicate
            const existing = this.projectStore.getProjects().find(p => p.path === projectPath);
            if (existing) {
                vscode.window.showWarningMessage(`Project '${projectName}' is already in the list.`);
                return;
            }

            try {
                await this.projectStore.addProject(projectName, projectPath);
                await this.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add project: ${error}`);
            }
        }
    }

    // Manage file watchers for all projects
    private fileWatchers: vscode.FileSystemWatcher[] = [];

    private refreshWatchers() {
        const projects = this.projectStore.getProjects();
        console.log(`[Watcher] Refreshing watchers for ${projects.length} projects`);

        // Simple check to avoid redundant recreation if project paths haven't changed
        // Use normalized paths for comparison to avoid case-sensitivity issues in some environments
        const currentPaths = projects.map(p => this.normalizePath(p.path)).sort().join('|');
        if ((this as any)._lastWatcherPaths === currentPaths) {
            console.log('[Watcher] Projects unchanged, skipping recreation');
            return;
        }
        (this as any)._lastWatcherPaths = currentPaths;

        // Dispose old watchers
        this.fileWatchers.forEach(w => w.dispose());
        this.fileWatchers = [];

        projects.forEach(project => {
            const normPath = this.normalizePath(project.path);
            console.log(`[Watcher] Creating multiple watchers for ${normPath}`);

            // Pattern 1: Any file change inside .agent/skills (recursive)
            // Pattern 2: Changes to the .agent/skills directory itself (like adding new top-level skill folders)
            // Pattern 3: Broader watcher for the .agent folder to be safe
            // Use both casing just in case
            const patterns = [
                '.agent/skills/**/*',
                '.agent/skills',
                '.agent/Skills/**/*',
                '.agent/Skills',
                '.agent/**/*'
            ];

            const debouncedRefresh = this.debounce((reason: string) => {
                console.log(`[Watcher] Triggering refresh for ${project.name}. Reason: ${reason}`);
                this.refresh();
            }, 500);

            patterns.forEach(p => {
                const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(normPath), p));
                watcher.onDidCreate((uri) => {
                    console.log(`[Watcher][${p}] File created: ${uri.fsPath}`);
                    debouncedRefresh(`Create ${uri.fsPath}`);
                });
                watcher.onDidChange((uri) => {
                    console.log(`[Watcher][${p}] File changed: ${uri.fsPath}`);
                    debouncedRefresh(`Change ${uri.fsPath}`);
                });
                watcher.onDidDelete((uri) => {
                    console.log(`[Watcher][${p}] File deleted: ${uri.fsPath}`);
                    debouncedRefresh(`Delete ${uri.fsPath}`);
                });
                this.fileWatchers.push(watcher);
            });
        });
    }

    private checkAndRefreshIfProjectsChanged() {
        const projects = this.projectStore.getProjects();
        const currentPaths = projects.map(p => this.normalizePath(p.path)).sort().join('|');
        if ((this as any)._lastAutoSyncPaths !== currentPaths) {
            console.log('[AutoSync] Projects changed in storage, refreshing...');
            (this as any)._lastAutoSyncPaths = currentPaths;
            this.refresh();
        }
    }

    private debounce(func: Function, wait: number) {
        let timeout: NodeJS.Timeout;
        return (...args: any[]) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    public async refresh() {
        console.log('[Refresh] refresh() called');
        if (this._view) {
            const projects = this.projectStore.getProjects();
            this.refreshWatchers();

            const projectSessions: { [key: string]: Session[] } = {};
            const projectSkills: { [key: string]: any[] } = {};

            let activeProjectPath: string | null = null;
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                activeProjectPath = this.normalizePath(vscode.workspace.workspaceFolders[0].uri.fsPath);
            }

            for (const project of projects) {
                try {
                    const normPath = this.normalizePath(project.path);
                    const sessions = await this.sessionParser.getSessionsForProject(normPath);
                    projectSessions[project.id] = sessions.slice(0, 3);
                    const skills = await this.skillService.getSkillsForProject(normPath);
                    // Only update if skills were successfully fetched or the directory exists
                    if (skills && (skills.length > 0 || fs.existsSync(path.join(normPath, '.agent/skills')) || fs.existsSync(path.join(normPath, '.agent/Skills')))) {
                        projectSkills[project.id] = skills;
                    }
                } catch (error) {
                    console.error(`Failed to load data for project ${project.name}:`, error);
                }
            }

            // Also fetch conversations
            const conversations = await this.fetchAndSendConversations();

            console.log('[Refresh] Sending update to webview');
            this._view.webview.postMessage({
                type: 'update',
                projects: projects,
                sessions: projectSessions,
                skills: Object.keys(projectSkills).length > 0 ? projectSkills : undefined,
                activeProjectPath: activeProjectPath,
                conversations: conversations && conversations.length > 0 ? conversations.map(c => ({
                    id: c.cascadeId,
                    title: c.title,
                    timeAgo: c.timeAgo,
                    lastModifiedAt: c.lastModifiedAt,
                    workspacePath: c.workspacePath
                })) : undefined
            });
        }
    }

    private normalizePath(p: string): string {
        // DO NOT use toLowerCase() here, as macOS and other OSes might have
        // case-sensitive listeners or patterns even if the FS is case-insensitive.
        return path.normalize(p).replace(/[\\/]$/, '');
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'styles.css'));
        const folderIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'folder-icon.png'));
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
                <link href="${styleUri}" rel="stylesheet">
                <title>Projects</title>
                <script nonce="${nonce}">
                    const folderIconUri = "${folderIconUri}";
                </script>
            </head>
            <body>
                <div id="app">
                    <div id="project-list"></div>

                    <div class="footer">
                        <div class="usage-display">
                            <!-- Groups Overview -->
                            <div class="usage-groups" id="usage-groups">
                                <!-- Injected by JS -->
                            </div>

                            <!-- Expandable List for Details -->
                            <div class="usage-header-row" id="usage-header-row" title="Click to expand">
                                <span class="toggle-label">Details</span>
                                <div class="toggle-icon" id="toggle-icon">▼</div>
                            </div>
                            <div class="usage-list" id="usage-list">
                                <!-- Injected by JS -->
                            </div>
                        </div>
                    </div>
                </div>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }

    // Background process to fetch detailed steps and update workspace paths
    private async enrichConversationsWithWorkspace(conversations: Conversation[]) {
        if (!this.cachedPort || !this.cachedCsrfToken) return;
        const port = this.cachedPort;
        const token = this.cachedCsrfToken;

        let updatedCount = 0;

        // Process in chunks to avoid flooding the API
        const chunkSize = 5;
        for (let i = 0; i < conversations.length; i += chunkSize) {
            const chunk = conversations.slice(i, i + chunkSize);
            const promises = chunk.map(async (convo) => {
                // Skip if already has workspace path
                if (convo.workspacePath) return;

                const steps = await this.conversationService.getConversationSteps(
                    port,
                    token,
                    convo.cascadeId
                );

                const workspacePath = this.conversationService.extractWorkspaceFromSteps(steps);
                if (workspacePath) {
                    convo.workspacePath = workspacePath;
                    updatedCount++;
                }
            });

            await Promise.all(promises);

            // Send update after each chunk if changes were found
            if (updatedCount > 0 && this._view) {
                // We send the FULL list with updates
                this._view.webview.postMessage({
                    type: 'conversationsUpdate',
                    conversations: conversations.map(c => ({
                        id: c.cascadeId,
                        title: c.title,
                        timeAgo: c.timeAgo,
                        lastModifiedAt: c.lastModifiedAt,
                        workspacePath: c.workspacePath
                    }))
                });
            }
        }
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
