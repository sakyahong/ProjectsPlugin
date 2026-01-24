import * as https from 'https';
import { Conversation } from '../types';

export class ConversationService {
    // Fetch conversations from the Language Server API
    async fetchConversations(port: number, csrfToken: string): Promise<Conversation[]> {
        // Use same format as quotaService which works
        const data = JSON.stringify({});

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
            rejectUnauthorized: false
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    console.log('Conversations API status:', res.statusCode);
                    if (res.statusCode === 200) {
                        try {
                            const response = JSON.parse(body);
                            console.log('Conversations API raw response:', JSON.stringify(response).substring(0, 500));
                            const conversations = this.processConversationsResponse(response);
                            console.log(`Parsed ${conversations.length} conversations`);
                            resolve(conversations);
                        } catch (e) {
                            console.error('Failed to parse conversations response:', e);
                            resolve([]);
                        }
                    } else {
                        console.error(`Conversations API failed with status ${res.statusCode}, body:`, body.substring(0, 200));
                        resolve([]);
                    }
                });
            });

            req.on('error', error => {
                console.error('Conversations API error:', error);
                resolve([]);
            });
            req.write(data);
            req.end();
        });
    }

    // Test LoadTrajectory API to get detailed info including workspace
    async loadTrajectoryDetails(port: number, csrfToken: string, trajectoryId: string): Promise<any> {
        const data = JSON.stringify({ trajectoryId });

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
            rejectUnauthorized: false
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    console.log('LoadTrajectory API status:', res.statusCode);
                    if (res.statusCode === 200) {
                        try {
                            const response = JSON.parse(body);
                            console.log('LoadTrajectory response (first 1000 chars):', JSON.stringify(response).substring(0, 1000));
                            resolve(response);
                        } catch (e) {
                            console.error('Failed to parse LoadTrajectory response:', e);
                            resolve(null);
                        }
                    } else {
                        console.error(`LoadTrajectory API failed with status ${res.statusCode}`);
                        resolve(null);
                    }
                });
            });

            req.on('error', error => {
                console.error('LoadTrajectory API error:', error);
                resolve(null);
            });
            req.write(data);
            req.end();
        });
    }


    // Fetch detailed steps for a conversation to find workspace context
    async getConversationSteps(port: number, csrfToken: string, cascadeId: string): Promise<any> {
        const data = JSON.stringify({ cascadeId });
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
            rejectUnauthorized: false
        };

        return new Promise((resolve) => {
            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const response = JSON.parse(body);
                            resolve(response);
                        } catch (e) {
                            console.error(`Failed to parse steps for ${cascadeId}:`, e);
                            resolve(null);
                        }
                    } else {
                        // Don't log 404s/500s too noisily for every conversation
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
