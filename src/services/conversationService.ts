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

            // Regex to capture absolute paths: /Users/..., /Volumes/..., etc.
            // Use a broader character set for path segments to handle special chars, spaces, usage of % for encoded paths, etc.
            // Exclude & and other special control characters to prevent matching URL parameters or complex strings
            const matches = [...jsonStr.matchAll(/(?:file:\/\/)?(\/(?:Users|Volumes|home|opt|var)\/(?:[^\\/:"*?<>|\r\n&]+\/)*[^\\/:"*?<>|\r\n&]+)/g)];

            console.log(`[Heuristic] Found ${matches.length} path matches in steps`);
            if (matches.length === 0) {
                // Debug: why are we missing paths?
                console.log(`[Heuristic] NO MATCHES. JSON sample: ${jsonStr.slice(0, 300)}...`);
            }

            for (const m of matches) {
                let pathStr = m[1] || m[0];

                // Decode URI components if it looks encoded (e.g. %20)
                try {
                    if (pathStr.includes('%')) {
                        pathStr = decodeURIComponent(pathStr);
                    }
                } catch (e) {
                    // ignore decoding errors
                }

                // Filter out system and build paths that confuse association
                if (pathStr.includes('.gemini') ||
                    pathStr.includes('Library/Application Support') ||
                    pathStr.includes('Library/Developer') || // Xcode DerivedData
                    pathStr.includes('DerivedData') ||
                    pathStr.includes('/var/folders') ||
                    pathStr.includes('.vscode/extensions') ||
                    pathStr.includes('/node_modules/') ||
                    pathStr.includes('/.git/')) {
                    continue;
                }

                // Found a likely project source path
                // Use extractRootPath to get project root instead of file path
                // Ensure we add file:// schema for extractRootPath validation if needed,
                // but extractRootPath handles raw strings mostly.
                const projectRoot = this.extractRootPath('file://' + pathStr);

                // Additional check: project root should not contain &
                if (projectRoot && projectRoot.length > 1 && !projectRoot.includes('&')) {
                    console.log(`[PathExtract] Found file: ${pathStr} → Project: ${projectRoot}`);
                    return projectRoot;
                }
            }
        } catch (e) {
            // ignore
        }

        return null;
    }

    private extractRootPath(fileUri: string): string {
        if (!fileUri) return '';

        // Convert file URI to path
        let filePath = fileUri.replace(/^file:\/\//, '');
        filePath = decodeURIComponent(filePath);

        // 智能推断项目根目录
        const parts = filePath.split('/').filter(p => p);

        // 检测是否是纯目录路径(不是文件)
        const lastPart = parts[parts.length - 1];
        const isFile = lastPart && lastPart.includes('.');

        // 如果是文件路径,需要移除文件名
        // 如果是目录路径,直接使用
        const dirParts = isFile ? parts.slice(0, -1) : parts;

        // 根据路径模式推断项目根目录
        // 关键:用户主目录下通常是 /Users/username/SomeFolder/ProjectName
        // 外部磁盘通常是 /Volumes/DiskName/SomeFolder/SomeFolder/ProjectName

        if (dirParts[0] === 'Users' && dirParts.length >= 4) {
            // macOS 用户目录: /Users/username/folder/project/...
            // 项目根目录在第4层 (Downloads/Ares, Documents/MyProject, etc.)
            return '/' + dirParts.slice(0, 4).join('/');
        }

        if (dirParts[0] === 'Users' && dirParts.length === 3) {
            // macOS 用户目录但只有3层: /Users/username/project
            return '/' + dirParts.slice(0, 3).join('/');
        }

        if (dirParts[0] === 'Volumes' && dirParts.length >= 5) {
            // macOS 外部磁盘: /Volumes/DiskName/Folder/Folder/ProjectName/...
            // 项目根目录在第5层
            return '/' + dirParts.slice(0, 5).join('/');
        }

        if (dirParts[0] === 'Volumes' && dirParts.length === 4) {
            // macOS 外部磁盘但只有4层
            return '/' + dirParts.slice(0, 4).join('/');
        }

        if (dirParts[0] === 'home' && dirParts.length >= 4) {
            // Linux 用户目录: /home/username/folder/project/...
            return '/' + dirParts.slice(0, 4).join('/');
        }

        if (dirParts[0] === 'home' && dirParts.length === 3) {
            // Linux 用户目录但只有3层
            return '/' + dirParts.slice(0, 3).join('/');
        }

        // Fallback: 返回目录路径本身(如果足够短)或截取前几层
        if (dirParts.length <= 4) {
            return '/' + dirParts.join('/');
        }

        // 最终 fallback: 返回前4层
        return '/' + dirParts.slice(0, 4).join('/');
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
            const normalizePath = (p: string) => {
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

            const normalizedConvoPath = normalizePath(c.workspacePath);
            const normalizedWorkspacePath = normalizePath(workspacePath);

            // STRICT MATCHING
            // 1. Exact match
            if (normalizedConvoPath === normalizedWorkspacePath) return true;

            // 2. Child directory match (Convo is inside Workspace)
            // MUST end with / or be exact match to avoid partial name matching (e.g. Project1 vs Project10)
            if (normalizedWorkspacePath.startsWith(normalizedConvoPath + '/') ||
                normalizedWorkspacePath.startsWith(normalizedConvoPath + '\\')) {
                return true;
            }

            // 3. Parent directory match (Workspace is inside Convo - less likely but possible if we open subfolder)
            if (normalizedConvoPath.startsWith(normalizedWorkspacePath + '/') ||
                normalizedConvoPath.startsWith(normalizedWorkspacePath + '\\')) {
                return true;
            }

            return false;
        });
    }
}
