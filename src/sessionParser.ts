import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Session } from './types';

export class SessionParser {
    // This defines where we EXPECT the brain implementation to rely.
    // Since we haven't found the files yet, we will use this path to search,
    // but fall back to mocks if empty.
    private readonly brainPath: string;

    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        this.brainPath = path.join(homeDir, '.gemini', 'antigravity', 'brain');
    }

    public async getSessionsForProject(projectPath: string): Promise<Session[]> {
        // TODO: Implement actual file reading once we locate the session files.
        // For now, return mock data to demonstrate the UI.

        return this.generateMockSessions();
    }

    private generateMockSessions(): Session[] {
        const now = Date.now();
        const hour = 3600 * 1000;
        const day = 24 * hour;

        return [
            {
                id: '1',
                title: 'Can we look into integration...',
                lastModifiedAt: now - 15 * 60 * 1000,
                timeAgo: '15m'
            },
            {
                id: '2',
                title: 'Could we make a plan for...',
                lastModifiedAt: now - 5 * hour,
                timeAgo: '5h'
            },
            {
                id: '3',
                title: 'Can you review the diff...',
                lastModifiedAt: now - 5 * hour,
                timeAgo: '5h'
            }
        ];
    }
}
