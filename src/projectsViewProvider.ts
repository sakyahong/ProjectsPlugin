import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
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
    private backgroundDetectorTimer?: NodeJS.Timeout;
    private cachedPort?: number;
    private cachedCsrfToken?: string;
    private isDetecting: boolean = false;

    private conversationTimer?: NodeJS.Timeout;
    private autoSyncTimer?: NodeJS.Timeout;
    private conversationPathCache: Map<string, string> = new Map();

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

        // Polling for Conversations (every 15s)
        this.conversationTimer = setInterval(() => {
            this.fetchAndSendConversations();
        }, 15000);

        // Background Detector Polling (every 15s)
        this.backgroundDetectorTimer = setInterval(() => {
            this.runBackgroundDetection();
        }, 15000);

        // Auto-sync for projects (every 5s) to detect changes from other windows
        this.autoSyncTimer = setInterval(() => {
            this.checkAndRefreshIfProjectsChanged();
        }, 5000);

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
                case 'revealInOS':
                    if (data.path) {
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(data.path));
                    }
                    break;
                case 'openFile':
                    if (data.path) {
                        const uri = vscode.Uri.file(data.path);
                        vscode.commands.executeCommand('vscode.open', uri);
                    }
                    break;
                case 'deleteSkill':
                    if (data.path) {
                        this.handleDeleteSkill(data.path);
                    }
                    break;
                case 'applySkill':
                    if (data.path) {
                        this.handleApplySkill(data.path);
                    }
                    break;
                case 'refresh':
                case 'onLoad':
                    this.refresh();
                    this.triggerAsyncLoad();
                    break;
            }
        });
    }

    private async handleChatRequest(cascadeId: string, projectPath: string) {
        // Use normalized but case-preserving path for system commands
        const targetPath = projectPath.replace(/^file:\/\//, '');

        // Use lowercased version ONLY for comparison logic
        const currentWorkspaceLower = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase();
        const targetPathLower = targetPath.toLowerCase();

        if (currentWorkspaceLower === targetPathLower) {
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
                });
                vscode.commands.executeCommand('vscode.openFolder', uri, false);
            }
        }
    }

    private async handleDeleteSkill(skillPath: string) {
        const skillName = path.basename(skillPath);
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the skill "${skillName}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            try {
                fs.rmSync(skillPath, { recursive: true, force: true });
                // Refresh twice to ensure watcher and manual sync are both caught
                this.refresh();
                setTimeout(() => this.refresh(), 500);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to delete skill: ${err.message}`);
            }
        }
    }

    private async handleApplySkill(sourcePath: string) {
        const projects = this.projectStore.getProjects();
        // Define Global Target
        const globalPath = path.join(os.homedir(), '.gemini/antigravity/global_skills');

        const targets: { label: string, description: string, targetPath: string }[] = [];

        // Check if source is global
        const isSourceGlobal = sourcePath.startsWith(globalPath);

        // Add Global option if not source
        if (!isSourceGlobal) {
            targets.push({
                label: 'Global Skills',
                description: 'Apply to global scope',
                targetPath: globalPath
            });
        }

        // Add Project options
        projects.forEach(p => {
            const projectSkillsPath = path.join(p.path, '.agent/skills');
            // Check if source is NOT inside this project
            // Simple string check is usually sufficient for standard paths
            if (!this.isSubPath(projectSkillsPath, sourcePath)) {
                targets.push({
                    label: p.name,
                    description: p.path,
                    targetPath: projectSkillsPath
                });
            }
        });

        if (targets.length === 0) {
            vscode.window.showInformationMessage('No other targets available to apply this skill.');
            return;
        }

        const selection = await vscode.window.showQuickPick(targets, {
            placeHolder: `Select target to apply "${path.basename(sourcePath)}"`
        });

        if (selection) {
            const destPath = path.join(selection.targetPath, path.basename(sourcePath));

            // Check existence
            if (fs.existsSync(destPath)) {
                const overwrite = await vscode.window.showWarningMessage(
                    `Skill "${path.basename(sourcePath)}" already exists in ${selection.label}. Overwrite?`,
                    'Yes', 'No'
                );
                if (overwrite !== 'Yes') return;
            }

            try {
                // Make sure parent exists
                if (!fs.existsSync(selection.targetPath)) {
                    fs.mkdirSync(selection.targetPath, { recursive: true });
                }

                // Copy
                // Use fs.cpSync if available (Node 16.7+), fallback to recursive copy helper if needed.
                // VS Code 1.80 uses Node 18, so cpSync is fine.
                // BUT we need to cast fs as any to avoid TS errors if types are old,
                // or just use a helper to be safe. Since I can't check types easily, I'll assume cpSync exists but wrap in try/catch or use a manual fallback if it fails?
                // Actually, let's write a simple recursive copy function to be 100% safe against TS/Node version mismatches in build env.
                this.copyFolderRecursiveSync(sourcePath, destPath);

                vscode.window.showInformationMessage(`Successfully applied skill to ${selection.label}`);
                // Refresh explicitly
                setTimeout(() => this.refresh(), 500); // Wait a bit for file events
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to apply skill: ${err.message}`);
                console.error(err);
            }
        }
    }

    private isSubPath(parent: string, child: string) {
        const relative = path.relative(parent, child);
        return !relative.startsWith('..') && !path.isAbsolute(relative);
    }

    private copyFolderRecursiveSync(source: string, target: string) {
        if (!fs.existsSync(target)) {
            fs.mkdirSync(target, { recursive: true });
        }

        if (fs.lstatSync(source).isDirectory()) {
            const files = fs.readdirSync(source);
            files.forEach(file => {
                const curSource = path.join(source, file);
                const curTarget = path.join(target, file);
                if (fs.lstatSync(curSource).isDirectory()) {
                    this.copyFolderRecursiveSync(curSource, curTarget);
                } else {
                    fs.copyFileSync(curSource, curTarget);
                }
            });
        }
    }

    private async triggerAsyncLoad() {
        // Run detection if needed, then fire both Quota and Conversation fetches in parallel
        await this.runBackgroundDetection();
        this.fetchAndSendQuota();
        this.fetchAndSendConversations();
    }

    private async runBackgroundDetection() {
        if (this.isDetecting) return;
        this.isDetecting = true;
        try {
            console.log('[Detector] Background detection triggered');
            const processInfo = await this.portDetector.detect();
            if (processInfo) {
                this.cachedPort = processInfo.connectPort;
                this.cachedCsrfToken = processInfo.csrfToken;
                console.log(`[Detector] Service found on port ${this.cachedPort}`);
            } else {
                console.log('[Detector] Service not found');
            }
        } catch (error) {
            console.error('[Detector] Detection failed:', error);
        } finally {
            this.isDetecting = false;
        }
    }

    private async initQuotaFetching() {
        // Trigger once immediately
        this.triggerAsyncLoad();

        // Ensure periodic refresh
        if (this.quotaTimer) clearInterval(this.quotaTimer);
        this.quotaTimer = setInterval(() => this.fetchAndSendQuota(), 30000); // 30s for quota is enough
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
                groups: uiGroups,
                status: `Connected to :${this.cachedPort}`
            });
        } catch (error: any) {
            this._view.webview.postMessage({
                type: 'usageUpdate',
                groups: [],
                status: `Error: ${error.message}`
            });
            // Suppress initialization error as it's transient
            if (error.message && error.message.includes('LanguageServerClient must be initialized first')) {
                return;
            }
            console.error('Failed to fetch quota:', error);
        }

    }

    private async fetchAndSendConversations(projectPath?: string) {
        if (!this.cachedPort || !this.cachedCsrfToken) {
            console.log('[Conversations] Skipping fetch: no cached service info');
            return null;
        }

        if (!this._view) return null;

        try {
            const allConversations = await this.conversationService.fetchConversations(
                this.cachedPort,
                this.cachedCsrfToken
            );

            // Re-apply cached paths immediately to avoid UI flicker/disappearance
            allConversations.forEach(c => {
                if (!c.workspacePath) {
                    const cached = this.conversationPathCache.get(c.cascadeId);
                    if (cached) c.workspacePath = cached;
                }
            });

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
        const globalSkillsPath = path.join(os.homedir(), '.gemini/antigravity/global_skills');
        const currentPaths = [globalSkillsPath, ...projects.map(p => this.normalizePath(p.path))].sort().join('|');

        if ((this as any)._lastWatcherPaths === currentPaths) {
            return;
        }
        (this as any)._lastWatcherPaths = currentPaths;

        // Dispose old watchers
        this.fileWatchers.forEach(w => w.dispose());
        this.fileWatchers = [];

        // Global Skills Watcher
        if (fs.existsSync(globalSkillsPath)) {
            console.log(`[Watcher] Creating watcher for Global Skills: ${globalSkillsPath}`);
            const debouncedGlobalRefresh = this.debounce(() => this.refresh(), 500);
            const globalWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(globalSkillsPath, '**/*'));
            globalWatcher.onDidCreate(() => debouncedGlobalRefresh());
            globalWatcher.onDidChange(() => debouncedGlobalRefresh());
            globalWatcher.onDidDelete(() => debouncedGlobalRefresh());
            this.fileWatchers.push(globalWatcher);
        }

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

    private async checkAndRefreshIfProjectsChanged() {
        const projects = this.projectStore.getProjects();
        let changed = false;

        // Verify existence during sync
        for (const project of projects) {
            if (!fs.existsSync(project.path)) {
                console.log(`[AutoSync] Project folder missing, cleaning up: ${project.path}`);
                await this.projectStore.deleteProject(project.id);
                changed = true;
            }
        }

        const finalProjects = this.projectStore.getProjects();
        const currentPaths = finalProjects.map(p => this.normalizePath(p.path)).sort().join('|');
        if ((this as any)._lastAutoSyncPaths !== currentPaths || changed) {
            console.log('[AutoSync] Projects list or files changed, refreshing UI...');
            (this as any)._lastAutoSyncPaths = currentPaths;
            this.refresh();
        }
    }

    private async checkAndAutoAddWorkspace() {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            const projects = this.projectStore.getProjects();
            for (const folder of folders) {
                const normPath = this.normalizePath(folder.uri.fsPath);
                if (!projects.some(p => this.normalizePath(p.path) === normPath)) {
                    console.log(`[AutoAdd] Adding workspace folder to projects: ${normPath}`);
                    await this.projectStore.addProject(folder.name, normPath);
                }
            }
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
            // Auto add current workspace if missing
            await this.checkAndAutoAddWorkspace();

            const allProjects = this.projectStore.getProjects();
            const projects: Project[] = [];

            // Cleanup missing projects first
            for (const project of allProjects) {
                if (!fs.existsSync(project.path)) {
                    console.log(`[Cleanup] Project folder no longer exists, removing from store: ${project.path}`);
                    await this.projectStore.deleteProject(project.id);
                } else {
                    projects.push(project);
                }
            }

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
                    // Always set, even if empty, to ensure UI state sync
                    projectSkills[project.id] = skills;
                } catch (error) {
                    console.error(`Failed to load data for project ${project.name}:`, error);
                }
            }

            // Fetch Global Skills
            const globalSkillsPath = path.join(os.homedir(), '.gemini/antigravity/global_skills');

            // Ensure directory exists
            if (!fs.existsSync(globalSkillsPath)) {
                try {
                    fs.mkdirSync(globalSkillsPath, { recursive: true });
                } catch (err) { }
            }

            let globalSkills: any[] = [];
            try {
                if (fs.existsSync(globalSkillsPath)) {
                    globalSkills = await this.skillService.getSkillsFromPath(globalSkillsPath);
                }
            } catch (err) { }

            // Trigger async updates (Conversations & Quota) without blocking UI
            setTimeout(() => this.triggerAsyncLoad(), 0);

            console.log('[Refresh] Sending update to webview');
            this._view.webview.postMessage({
                type: 'update',
                projects: projects,
                sessions: projectSessions,
                skills: projectSkills, // Always send the object
                globalSkills: globalSkills,
                globalSkillsPath: globalSkillsPath,
                activeProjectPath: activeProjectPath
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
                        <div id="connection-status" style="font-size: 9px; color: var(--muted-text); padding: 4px 8px; border-bottom: 1px solid var(--border-color); text-align: right;">
                            Detecting...
                        </div>
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

        // Process in chunks to avoid flooding the API, but parallelize within chunks
        const chunkSize = 5;
        for (let i = 0; i < conversations.length; i += chunkSize) {
            const chunk = conversations.slice(i, i + chunkSize);

            // Fetch this chunk in parallel
            await Promise.all(chunk.map(async (convo) => {
                // Skip if already has workspace path in cache or object
                if (convo.workspacePath) return;

                try {
                    const steps = await this.conversationService.getConversationSteps(
                        port,
                        token,
                        convo.cascadeId
                    );

                    const workspacePath = this.conversationService.extractWorkspaceFromSteps(steps);
                    if (workspacePath) {
                        convo.workspacePath = workspacePath;
                        this.conversationPathCache.set(convo.cascadeId, workspacePath);
                        updatedCount++;
                    }
                } catch (err) {
                    console.error(`[Enrich] Failed for ${convo.cascadeId}:`, err);
                }
            }));

            // Immediate partial update to UI for better perceived speed
            if (updatedCount > 0 && this._view) {
                this.sendConversationUpdate(conversations);
                updatedCount = 0; // Reset for next chunk monitoring if needed,
                // or just keep sending full updated list
            }
        }
    }

    private sendConversationUpdate(conversations: Conversation[]) {
        if (!this._view) return;
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

    // Final update happens via the loop's sendConversationUpdate calls
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
