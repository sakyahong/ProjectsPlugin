export interface Project {
    id: string;
    name: string;
    path: string;
    category: string;
    createdAt: number;
    lastOpenedAt: number;
}

export interface Session {
    id: string;
    title: string;
    lastModifiedAt: number;
    timeAgo?: string; // For display, e.g. "15m", "5h"
    summary?: string;
}

export interface Conversation {
    cascadeId: string;
    trajectoryId: string;
    title: string;
    lastModifiedAt: number;
    timeAgo?: string;
    workspacePath?: string;
}
