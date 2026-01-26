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
    extractWorkspaceFromSteps(stepsResponse: any): string | null {
        if (!stepsResponse || !stepsResponse.steps || !Array.isArray(stepsResponse.steps)) {
            // console.log('Invalid steps response structure');
            return null;
        }

        // Strategy 1: Check known fields (efficient)
        for (const step of stepsResponse.steps) {
            // Check activeUserState known paths
            const state = step.userInput?.activeUserState;
            if (state) {
                if (state.activeDocument?.uri) return this.extractRootPath(state.activeDocument.uri);
                if (state.visibleFiles?.[0]?.uri) return this.extractRootPath(state.visibleFiles[0].uri);
                if (state.workspacePath) return this.extractRootPath(state.workspacePath); // hypothetical
            }
            // Check metadata
            if (step.metadata?.workspaceContext?.rootUri) {
                return step.metadata.workspaceContext.rootUri;
            }
        }

        // Strategy 2: Brute force regex search (fallback)
        // Convert the whole steps object to string and look for file paths
        try {
            // Check first few steps fully
            const checkLimit = Math.min(stepsResponse.steps.length, 5);
            const jsonStr = JSON.stringify(stepsResponse.steps.slice(0, checkLimit));

            // Regex to capture deep paths: /Users/user/.../...
            // Find all matches to select the best one
            const matches = [...jsonStr.matchAll(/(?:file:\/\/)?(\/Users\/[-\w.+]+(?:\/[-\w.+ ]+)+)/g)];

            for (const m of matches) {
                const path = m[1] || m[0];
                // Filter out system and build paths that confuse association
                if (path.includes('.gemini') ||
                    path.includes('Library/Application Support') ||
                    path.includes('Library/Developer') || // Xcode DerivedData
                    path.includes('DerivedData') ||
                    path.includes('/var/folders') ||
                    path.includes('.vscode/extensions')) {
                    continue;
                }

                // Found a likely project source path
                // console.log(`[Heuristic] Found good path: ${path}`);
                return decodeURIComponent(path);
            }
        } catch (e) {
            // ignore
        }

        return null;
    }

    private extractRootPath(fileUri: string): string {
        if (!fileUri) return '';
        // Convert file URI to path and try to find project root (heuristic)
        // Simple heuristic: return the directory containing the file
        // Ideally we'd look for a common project root, but for now just getting a path is good
        // Remove file:// prefix
        let path = fileUri.replace(/^file:\/\//, '');
        // Decode URI components
        path = decodeURIComponent(path);

        // Return folder path (remove filename)
        return path.substring(0, path.lastIndexOf('/'));
    }

    // Process API response into Conversation array
    private processConversationsResponse(response: any): Conversation[] {
        if (!response || !response.result || !response.result.trajectorySummaries) {
            // Try alternate response paths
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
            // Truncate title to ensure privacy and UI neatness
            if (rawTitle.length > 60) {
                rawTitle = rawTitle.substring(0, 60) + '...';
            }

            conversations.push({
                cascadeId,
                trajectoryId: s.trajectoryId || '',
                title: rawTitle,
                lastModifiedAt,
                // Try multiple possible field names for workspace
                workspacePath: s.workspaceUri || s.workspacePath || s.workspace || s.folderUri || undefined,
                timeAgo: this.formatTimeAgo(lastModifiedAt)
            });
        }

        // Sort by last modified time (newest first)
        conversations.sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
        return conversations;
    }

    // Format timestamp to relative time
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

    // Filter conversations by workspace path
    filterByWorkspace(conversations: Conversation[], workspacePath: string): Conversation[] {
        return conversations.filter(c => {
            if (!c.workspacePath) return false;
            // Normalize paths for comparison
            const normalizedConvoPath = c.workspacePath.replace(/^file:\/\//, '').toLowerCase();
            const normalizedWorkspacePath = workspacePath.toLowerCase();
            return normalizedConvoPath.includes(normalizedWorkspacePath) ||
                normalizedWorkspacePath.includes(normalizedConvoPath);
        });
    }
}
