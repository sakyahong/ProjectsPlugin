import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SessionParser } from './sessionParser';
import { Project, Session, Conversation } from './types';
import { PortDetector } from './services/portDetector';
import { QuotaService, GroupedQuota } from './services/quotaService';
import { ConversationService } from './services/conversationService';
import { SkillService } from './services/skillService';

export class ProjectsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'antigravity.projectsView';
    private _view?: vscode.WebviewView;
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
        this.sessionParser = new SessionParser();
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

                case 'handleChatClick':
                    if (data.cascadeId) {
                        this.handleChatRequest(data.cascadeId, data.projectPath);
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
                case 'installSkill':
                    if (data.path) {
                        this.handleInstallSkill(data.path);
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

    private async handleChatRequest(cascadeId: string, projectPath?: string) {
        if (!projectPath) {
            vscode.commands.executeCommand('antigravity.setVisibleConversation', cascadeId);
            return;
        }

        // Robust path normalization
        let decodedPath = projectPath.replace(/^file:\/\//, '');
        try {
            decodedPath = decodeURIComponent(decodedPath);
        } catch (e) { }

        const targetPath = this.normalizePath(decodedPath);
        const currentWorkspaceFolders = vscode.workspace.workspaceFolders;
        const currentPath = currentWorkspaceFolders && currentWorkspaceFolders.length > 0
            ? this.normalizePath(currentWorkspaceFolders[0].uri.fsPath)
            : null;
        const targetPathLower = targetPath.toLowerCase();
        const currentPathLower = currentPath ? currentPath.toLowerCase() : null;

        // Path comparison: Same project if one is a subpath of another
        const isSameProject = currentPathLower && (
            currentPathLower === targetPathLower ||
            targetPathLower.startsWith(currentPathLower + '/') ||
            currentPathLower.startsWith(targetPathLower + '/')
        );

        if (isSameProject) {
            // Same project, just open chat
            vscode.commands.executeCommand('antigravity.setVisibleConversation', cascadeId);
        } else {
            // Different project - just open it
            const uri = vscode.Uri.file(targetPath);
            vscode.commands.executeCommand('vscode.openFolder', uri, false);
            // Switch Window (Reloads extension)
            // Persist pending chat with timestamp to meet extension.ts requirement
            await this.context.globalState.update('pendingOpenConversation', {
                id: cascadeId,
                timestamp: Date.now()
            });
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
        const folders = vscode.workspace.workspaceFolders || [];
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
        folders.forEach(f => {
            const folderPath = this.normalizePath(f.uri.fsPath);
            const projectSkillsPath = path.join(folderPath, '.agent/skills');
            // Check if source is NOT inside this project
            if (!this.isSubPath(projectSkillsPath, sourcePath)) {
                targets.push({
                    label: f.name,
                    description: folderPath,
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
        // 1. If we have cached port/token, try to fetch immediately to show SOMETHING fast
        if (this.cachedPort && this.cachedCsrfToken) {
            this.fetchAndSendQuota();
            this.fetchAndSendConversations();
        }

        // 2. Run detection in parallel/background to refresh port info
        this.runBackgroundDetection().then(() => {
            // 3. After detection finishes, re-fire to ensure we have latest data
            this.fetchAndSendQuota();
            this.fetchAndSendConversations();
        });
    }

    private async handleInstallSkill(targetParentPath: string) {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Skill Folder to Install'
        });

        if (uris && uris.length > 0) {
            const sourcePath = uris[0].fsPath;
            const skillName = path.basename(sourcePath);
            const destPath = path.join(targetParentPath, skillName);

            try {
                // Ensure target parent exists
                if (!fs.existsSync(targetParentPath)) {
                    fs.mkdirSync(targetParentPath, { recursive: true });
                }

                if (fs.existsSync(destPath)) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Skill "${skillName}" already exists. Overwrite?`,
                        'Yes', 'No'
                    );
                    if (confirm !== 'Yes') return;
                }

                this.copyFolderRecursiveSync(sourcePath, destPath);
                vscode.window.showInformationMessage(`Skill "${skillName}" installed successfully.`);

                // Refresh explicitly
                this.refresh();
                setTimeout(() => this.refresh(), 500);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to install skill: ${err.message}`);
                console.error(err);
            }
        }
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
                groups: uiGroups
            });
        } catch (error: any) {
            // Do NOT send empty groups on error.
            // Better to show stale data than nothing.

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

            // CRITICAL: Send initial list to UI immediately!
            this.sendConversationUpdate(allConversations);

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



    // Manage file watchers for all projects
    private fileWatchers: vscode.FileSystemWatcher[] = [];

    private refreshWatchers(projects: Project[]) {
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

            // Unified pattern: watch all changes inside .agent folder (covers skills, Skills, workflows, etc.)
            const patterns = ['.agent/**/*'];

            const debouncedRefresh = this.debounce((reason: string) => {
                console.log(`[Watcher] Triggering refresh for ${project.name}. Reason: ${reason}`);
                this.refresh();
            }, 800);

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
            const projects: Project[] = [];
            const folders = vscode.workspace.workspaceFolders || [];

            for (const folder of folders) {
                const folderPath = this.normalizePath(folder.uri.fsPath);
                projects.push({
                    id: folderPath, // Use path as ID since it's unique per workspace
                    name: folder.name,
                    path: folderPath,
                    category: '',
                    createdAt: 0,
                    lastOpenedAt: Date.now()
                });
            }

            // Set dynamic title if single project
            if (projects.length === 1) {
                this._view.title = projects[0].name;
            } else {
                this._view.title = 'Projects'; // Default/Fallback
            }

            this.refreshWatchers(projects);

            let activeProjectPath: string | null = null;
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                activeProjectPath = this.normalizePath(vscode.workspace.workspaceFolders[0].uri.fsPath);
            }

            // --- PHASE 1: Immediate Update (Projects only for instant UI response) ---
            this._view.webview.postMessage({
                type: 'update',
                projects: projects,
                activeProjectPath: activeProjectPath,
                partial: true
            });

            // TRIGGER ASYNC LOAD EARLY (Parallel with Phase 2)
            // Do not wait for project details to load before fetching chats/quota
            this.triggerAsyncLoad();

            // --- PHASE 2: Parallelized Detail Loading ---
            (async () => {
                const projectSessions: { [key: string]: Session[] } = {};
                const projectSkills: { [key: string]: any[] } = {};

                // 1. Define Global Skills Fetch logic
                const globalSkillsPath = path.join(os.homedir(), '.gemini/antigravity/global_skills');
                const fetchGlobalSkills = async () => {
                    if (!fs.existsSync(globalSkillsPath)) {
                        try { fs.mkdirSync(globalSkillsPath, { recursive: true }); } catch (err) { }
                    }
                    if (fs.existsSync(globalSkillsPath)) {
                        try {
                            return await this.skillService.getSkillsFromPath(globalSkillsPath);
                        } catch (e) { return []; }
                    }
                    return [];
                };
                const globalSkillsPromise = fetchGlobalSkills();

                // 2. Define Project Fetch logic (Concurrent per project)
                const fetchProjectData = async (project: Project) => {
                    try {
                        const normPath = this.normalizePath(project.path);
                        // Inner parallel fetch for independent data sources
                        const [sessions, skills] = await Promise.all([
                            this.sessionParser.getSessionsForProject(normPath).then(s => s.slice(0, 3)),
                            this.skillService.getSkillsForProject(normPath)
                        ]);

                        projectSessions[project.id] = sessions;
                        projectSkills[project.id] = skills;

                        console.log(`[Phase2] Loaded for ${project.name}: sessions=${sessions.length}, skills=${skills.length}`);

                        // Immediate partial update for this project
                        this._view?.webview.postMessage({
                            type: 'update',
                            projects: projects,
                            sessions: projectSessions,
                            skills: projectSkills,
                            activeProjectPath: activeProjectPath,
                            partial: true
                        });
                        console.log(`[Phase2] Sent partial update for ${project.name}`);
                    } catch (error) {
                        console.error(`Failed to load data for project ${project.name}:`, error);
                    }
                };

                // 3. Execute all concurrently
                await Promise.all([
                    ...projects.map(p => fetchProjectData(p)),
                    globalSkillsPromise
                ]);

                // 4. Final Update (All settled)
                const globalSkills = await globalSkillsPromise;

                console.log(`[Phase2] Final update - projects: ${projects.length}, sessions keys: ${Object.keys(projectSessions)}, skills keys: ${Object.keys(projectSkills)}`);

                this._view?.webview.postMessage({
                    type: 'update',
                    projects: projects,
                    sessions: projectSessions,
                    skills: projectSkills,
                    globalSkills: globalSkills,
                    globalSkillsPath: globalSkillsPath,
                    activeProjectPath: activeProjectPath
                });
            })();
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
        const geminiIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'Gemini.png'));
        const anthropicIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'Claude.png'));
        const openaiIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'GPT.png'));
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
                    const geminiIconUri = "${geminiIconUri}";
                    const anthropicIconUri = "${anthropicIconUri}";
                    const openaiIconUri = "${openaiIconUri}";
                </script>
            </head>
            <body>
                <div id="app">
                    <div id="project-list"></div>

                    <div class="footer">
                        <div class="usage-display">
                            <div class="usage-container-card">
                                <!-- Groups Overview -->
                                <div class="usage-groups visible" id="usage-groups">
                                    <!-- Injected by JS -->
                                </div>
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
        const chunkSize = 3;
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
