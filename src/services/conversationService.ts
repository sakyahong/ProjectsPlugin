import * as http from 'http';
import { Conversation } from '../types';

export class ConversationService {
    // Fetch conversations from the Language Server API
    async fetchConversations(port: number, csrfToken: string, retries = 3): Promise<Conversation[]> {
        return new Promise((resolve) => {
            const attempt = (remaining: number) => {
                const data = JSON.stringify({
                    metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: '1.0.0', locale: 'en' }
                });
                const options = {
                    hostname: '127.0.0.1',
                    port: port,
                    path: '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                        'X-Codeium-Csrf-Token': csrfToken,
                        'Connect-Protocol-Version': '1'
                    },
                    timeout: 5000
                };

                const req = http.request(options, (res) => {
                    let body = '';
                    res.on('data', chunk => { body += chunk; });
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            try {
                                const response = JSON.parse(body);
                                const conversations = this.processConversationsResponse(response);
                                resolve(conversations);
                            } catch (e) {
                                if (remaining > 0) {
                                    setTimeout(() => attempt(remaining - 1), 1000);
                                } else {
                                    resolve([]);
                                }
                            }
                        } else {
                            if (remaining > 0) {
                                setTimeout(() => attempt(remaining - 1), 1000);
                            } else {
                                resolve([]);
                            }
                        }
                    });
                });

                req.on('error', error => {
                    if (remaining > 0) {
                        setTimeout(() => attempt(remaining - 1), 1000);
                    } else {
                        resolve([]);
                    }
                });

                req.on('timeout', () => {
                    req.destroy();
                    if (remaining > 0) {
                        attempt(remaining - 1);
                    } else {
                        resolve([]);
                    }
                });

                req.write(data);
                req.end();
            };

            attempt(retries);
        });
    }


    // Test LoadTrajectory API to get detailed info including workspace
    async loadTrajectoryDetails(port: number, csrfToken: string, trajectoryId: string): Promise<any> {
        const data = JSON.stringify({ trajectoryId, metadata: { ideName: 'antigravity' } });

        const options = {
            hostname: '127.0.0.1',
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/LoadTrajectory',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'X-Codeium-Csrf-Token': csrfToken,
                'Connect-Protocol-Version': '1'
            },
            timeout: 5000
        };

        return new Promise((resolve) => {
            const req = http.request(options, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const response = JSON.parse(body);
                            resolve(response);
                        } catch (e) {
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.write(data);
            req.end();
        });
    }


    // Fetch detailed steps for a conversation to find workspace context
    async getConversationSteps(port: number, csrfToken: string, cascadeId: string): Promise<any> {
        const data = JSON.stringify({ cascadeId, metadata: { ideName: 'antigravity' } });
        const options = {
            hostname: '127.0.0.1',
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'X-Codeium-Csrf-Token': csrfToken,
                'Connect-Protocol-Version': '1'
            },
            timeout: 5000
        };

        return new Promise((resolve) => {
            const req = http.request(options, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const response = JSON.parse(body);
                            resolve(response);
                        } catch (e) {
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.write(data);
            req.end();
        });
    }


    // Extract workspace path from conversation steps
    extractWorkspaceFromSteps(stepsResponse: any, conversationTitle?: string): string | null {
        if (!stepsResponse) {
            console.log(`[PathExtract] No stepsResponse for: ${conversationTitle || 'unknown'}`);
            return null;
        }

        // Handle different response structures
        const steps = stepsResponse.steps || stepsResponse.result?.steps || [];
        if (!Array.isArray(steps) || steps.length === 0) {
            console.log(`[PathExtract] No steps array for: ${conversationTitle || 'unknown'}`);
            return null;
        }

        console.log(`[PathExtract] Processing ${steps.length} steps for: ${conversationTitle || 'unknown'}`);

        // Strategy 1: Check known fields (efficient)
        for (const step of steps) {
            // Check userInput.activeUserState
            const state = step.userInput?.activeUserState;
            if (state) {
                if (state.activeDocument?.uri) {
                    const path = this.extractRootPath(state.activeDocument.uri);
                    if (path) {
                        console.log(`[PathExtract] Found via activeDocument: ${path}`);
                        return path;
                    }
                }
                if (state.visibleFiles?.[0]?.uri) {
                    const path = this.extractRootPath(state.visibleFiles[0].uri);
                    if (path) {
                        console.log(`[PathExtract] Found via visibleFiles: ${path}`);
                        return path;
                    }
                }
                if (state.workspacePath) {
                    const path = this.extractRootPath(state.workspacePath);
                    if (path) {
                        console.log(`[PathExtract] Found via workspacePath field: ${path}`);
                        return path;
                    }
                }
            }

            // Check metadata.workspaceContext
            if (step.metadata?.workspaceContext?.rootUri) {
                console.log(`[PathExtract] Found via workspaceContext: ${step.metadata.workspaceContext.rootUri}`);
                return step.metadata.workspaceContext.rootUri;
            }

            // Check toolResults for file paths
            if (step.toolResults) {
                for (const result of step.toolResults) {
                    if (result.path || result.filePath || result.uri) {
                        const uri = result.path || result.filePath || result.uri;
                        const path = this.extractRootPath(uri);
                        if (path && this.isValidProjectPath(path)) {
                            console.log(`[PathExtract] Found via toolResults: ${path}`);
                            return path;
                        }
                    }
                }
            }
        }

        // Strategy 2: Brute force regex search (fallback)
        try {
            const checkLimit = Math.min(steps.length, 20); // Increased limit
            const jsonStr = JSON.stringify(steps.slice(0, checkLimit));

            // Enhanced regex: matches more path patterns
            // Supports: /Users, /Volumes, /home, /opt, /var, /mnt, /tmp, /private
            const pathRegex = /(?:file:\/\/)?(\/(?:Users|Volumes|home|opt|var|mnt|tmp|private\/(?:var|tmp))\/[^\s"'<>|\r\n]+?\/[^\s"'<>|\r\n]+)/gi;
            const matches = [...jsonStr.matchAll(pathRegex)];

            console.log(`[PathExtract] Regex found ${matches.length} potential paths`);

            for (const m of matches) {
                let pathStr = m[1] || m[0];

                // Enhanced cleanup: Remove trailing backticks, punctuation, and invalid sequences
                pathStr = pathStr.replace(/[`"',;:\]\}\)\n\r\\]+.*$/g, ''); // Stop at first invalid char
                pathStr = pathStr.replace(/\.\/n.*$/g, ''); // Remove ./n sequences
                pathStr = pathStr.replace(/[`"',;:\]\}]+$/, ''); // Ensure no trailing special chars
                pathStr = pathStr.split(/[\s"'<>`]/)[0]; // Stop at whitespace or special chars
                pathStr = pathStr.replace(/\/+$/, ''); // Remove trailing slashes

                try {
                    if (pathStr.includes('%')) {
                        pathStr = decodeURIComponent(pathStr);
                    }
                } catch (e) { }

                // Skip system/temporary paths
                if (!this.isValidProjectPath(pathStr)) {
                    continue;
                }

                const projectRoot = this.extractRootPath('file://' + pathStr);
                if (projectRoot && projectRoot.length > 5 && !projectRoot.includes('&')) {
                    console.log(`[PathExtract] Found via regex: ${projectRoot}`);
                    return projectRoot;
                }
            }
        } catch (e) {
            console.log(`[PathExtract] Regex error:`, e);
        }

        console.log(`[PathExtract] No path found for: ${conversationTitle || 'unknown'}`);
        return null;
    }

    // Check if a path is a valid project path (not system/temp)
    private isValidProjectPath(pathStr: string): boolean {
        const invalidPatterns = [
            '.gemini/antigravity',
            'Library/Application Support',
            'Library/Developer',
            'DerivedData',
            '/var/folders',
            '.vscode/extensions',
            '/node_modules/',
            '/.git/',
            '/Caches/',
            '/tmp/',
            '/private/var',
            '/private/tmp',
            'Application Support'
        ];

        for (const pattern of invalidPatterns) {
            if (pathStr.includes(pattern)) {
                return false;
            }
        }
        return true;
    }

    private extractRootPath(fileUri: string): string {
        if (!fileUri) return '';

        let filePath = fileUri.replace(/^file:\/\//, '');
        try {
            filePath = decodeURIComponent(filePath);
        } catch (e) { }

        // Standardize separators and remove trailing slash
        filePath = filePath.replace(/\\/g, '/').replace(/\/+$/, '');

        // NEW ROBUST LOGIC: Just get the directory of the file.
        // Containment logic in filterByWorkspace handles the rest.
        const basename = filePath.split('/').pop() || '';
        if (basename.includes('.') && !basename.startsWith('.')) {
            const lastSlash = filePath.lastIndexOf('/');
            if (lastSlash > 0) {
                return filePath.substring(0, lastSlash);
            }
        }

        return filePath;
    }

    // Process API response into Conversation array
    private processConversationsResponse(response: any): Conversation[] {
        if (!response || !response.result || !response.result.trajectorySummaries) {
            if (response?.trajectorySummaries) {
                return this.parseSummaries(response.trajectorySummaries);
            }
            return [];
        }

        return this.parseSummaries(response.result.trajectorySummaries);
    }

    private parseSummaries(summaries: Record<string, any>): Conversation[] {
        const conversations: Conversation[] = [];

        for (const [cascadeId, summary] of Object.entries(summaries)) {
            const s = summary as any;
            const lastModifiedAt = s.lastModifiedTime ?
                new Date(s.lastModifiedTime).getTime() : Date.now();

            let rawTitle = s.summary || s.title || s.firstUserMessage || 'Untitled Conversation';
            if (rawTitle.length > 60) {
                rawTitle = rawTitle.substring(0, 60) + '...';
            }

            conversations.push({
                cascadeId,
                trajectoryId: s.trajectoryId || '',
                title: rawTitle,
                lastModifiedAt,
                workspacePath: s.workspaceUri || s.workspacePath || s.workspace || s.folderUri || undefined,
                timeAgo: this.formatTimeAgo(lastModifiedAt)
            });
        }

        conversations.sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
        return conversations;
    }

    private formatTimeAgo(timestamp: number): string {
        const now = Date.now();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        return new Date(timestamp).toLocaleDateString();
    }

    filterByWorkspace(conversations: Conversation[], workspacePath: string): Conversation[] {
        return conversations.filter(c => {
            if (!c.workspacePath) return false;

            const normalize = (p: string) => {
                if (!p) return '';
                try {
                    return decodeURIComponent(p.replace(/^file:\/\//, ''))
                        .replace(/\\/g, '/')
                        .replace(/\/$/, '')
                        .toLowerCase();
                } catch (e) {
                    return p.replace(/^file:\/\//, '').toLowerCase();
                }
            };

            const normalizedConvoPath = normalize(c.workspacePath);
            const normalizedWorkspacePath = normalize(workspacePath);

            // 1. Exact match
            if (normalizedConvoPath === normalizedWorkspacePath) return true;

            // 2. Convo is inside Workspace (File match)
            if (normalizedConvoPath.startsWith(normalizedWorkspacePath + '/')) return true;

            // 3. Workspace is inside Convo (Parent folder match)
            if (normalizedWorkspacePath.startsWith(normalizedConvoPath + '/')) return true;

            return false;
        });
    }
}
