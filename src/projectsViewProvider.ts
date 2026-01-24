import * as vscode from 'vscode';
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

        // Live Watcher for Skills
        const skillsWatcher = vscode.workspace.createFileSystemWatcher('**/.agent/skills/**');
        skillsWatcher.onDidCreate(() => this.refresh());
        skillsWatcher.onDidChange(() => this.refresh());
        skillsWatcher.onDidDelete(() => this.refresh());
        context.subscriptions.push(skillsWatcher);

        // Polling for Conversations (every 30s)
        this.conversationTimer = setInterval(() => {
            this.fetchAndSendConversations();
        }, 30000);
        context.subscriptions.push({
            dispose: () => {
                if (this.conversationTimer) clearInterval(this.conversationTimer);
            }
        });
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
                case 'openProject': {
                    const uri = vscode.Uri.file(data.path);
                    vscode.commands.executeCommand('vscode.openFolder', uri, false);
                    this.projectStore.updateLastOpened(data.id);
                    break;
                }
                case 'deleteProject': {
                    await this.projectStore.deleteProject(data.id);
                    this.refresh();
                    break;
                }
                case 'openSettings': {
                    break;
                }
                case 'onLoad': {
                    this.refresh();
                    this.initQuotaFetching();
                    break;
                }
                case 'openConversation': {
                    // Open the conversation in Antigravity chat panel
                    try {
                        await vscode.commands.executeCommand(
                            'antigravity.setVisibleConversation',
                            data.cascadeId
                        );
                    } catch (error) {
                        console.error('Failed to open conversation:', error);
                        vscode.window.showErrorMessage('Failed to open conversation');
                    }
                    break;
                }
                case 'fetchConversations': {
                    // Fetch conversations for a specific project
                    await this.fetchAndSendConversations(data.projectPath);
                    break;
                }
            }
        });
    }

    private async initQuotaFetching() {
        try {
            const processInfo = await this.portDetector.detect();
            if (processInfo) {
                // Cache port and token for conversation fetching
                this.cachedPort = processInfo.connectPort;
                this.cachedCsrfToken = processInfo.csrfToken;

                // this.quotaService is already instantiated in constructor

                this.fetchAndSendQuota();

                // Poll every 5 seconds
                if (this.quotaTimer) clearInterval(this.quotaTimer);
                this.quotaTimer = setInterval(() => this.fetchAndSendQuota(), 5000);
            } else {
                console.log('Antigravity language server process not found.');
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
        } catch (error) {
            console.error('Failed to fetch quota:', error);
        }
    }

    private async fetchAndSendConversations(projectPath?: string) {

        // If port/token not available yet, try to detect
        if (!this.cachedPort || !this.cachedCsrfToken) {
            try {
                const processInfo = await this.portDetector.detect();
                if (processInfo) {
                    this.cachedPort = processInfo.connectPort;
                    this.cachedCsrfToken = processInfo.csrfToken;
                } else {
                    return;
                }
            } catch (error) {
                console.error('Failed to detect port:', error);
                return;
            }
        }

        if (!this._view) return;

        try {
            const allConversations = await this.conversationService.fetchConversations(
                this.cachedPort,
                this.cachedCsrfToken
            );

            // DEEP FETCH: Asynchronously fetch details for all conversations to find their workspace
            // Do this in background without blocking initial render
            if (allConversations.length > 0) {
                this.enrichConversationsWithWorkspace(allConversations);
            }

            // If projectPath is provided, filter by workspace
            // Otherwise send all conversations (don't filter since workspace association may not work)
            const conversations = allConversations; // Send all for now, filter client-side

            this._view.webview.postMessage({
                type: 'conversationsUpdate',
                projectPath: projectPath || null,
                conversations: conversations.map(c => ({
                    id: c.cascadeId,
                    title: c.title,
                    timeAgo: c.timeAgo,
                    lastModifiedAt: c.lastModifiedAt,
                    workspacePath: c.workspacePath
                }))
            });
        } catch (error) {
            console.error('Failed to fetch conversations:', error);
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

            await this.projectStore.addProject(projectName, projectPath);
            this.refresh();
        }
    }

    public async refresh() {
        if (this._view) {
            const projects = this.projectStore.getProjects();
            const projectSessions: { [key: string]: Session[] } = {};
            const projectSkills: { [key: string]: any[] } = {};

            for (const project of projects) {
                const sessions = await this.sessionParser.getSessionsForProject(project.path);
                projectSessions[project.id] = sessions.slice(0, 3);

                // Fetch Skills
                const skills = await this.skillService.getSkillsForProject(project.path);
                projectSkills[project.id] = skills;
            }

            this._view.webview.postMessage({
                type: 'update',
                projects: projects,
                sessions: projectSessions,
                skills: projectSkills
            });

            // Fetch conversations after projects are loaded
            // Pass null to get all conversations (will be filtered client-side)
            this.fetchAndSendConversations();
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'styles.css'));
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
                <link href="${styleUri}" rel="stylesheet">
                <title>Projects</title>
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
