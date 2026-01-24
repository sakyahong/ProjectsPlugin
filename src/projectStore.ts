import * as vscode from 'vscode';
import { Project } from './types';

export class ProjectStore {
    private static readonly KEY = 'antigravity.projects';

    constructor(private context: vscode.ExtensionContext) { }

    public getProjects(): Project[] {
        return this.context.globalState.get<Project[]>(ProjectStore.KEY, []);
    }

    public async addProject(name: string, path: string, category: string = ''): Promise<void> {
        const projects = this.getProjects();
        if (projects.some(p => p.path === path)) {
            return;
        }

        const newProject: Project = {
            id: Date.now().toString(),
            name,
            path,
            category,
            createdAt: Date.now(),
            lastOpenedAt: 0
        };

        projects.push(newProject);
        await this.context.globalState.update(ProjectStore.KEY, projects);
    }

    public async deleteProject(id: string): Promise<void> {
        let projects = this.getProjects();
        projects = projects.filter(p => p.id !== id);
        await this.context.globalState.update(ProjectStore.KEY, projects);
    }

    public async updateLastOpened(id: string): Promise<void> {
        const projects = this.getProjects();
        const project = projects.find(p => p.id === id);
        if (project) {
            project.lastOpenedAt = Date.now();
            await this.context.globalState.update(ProjectStore.KEY, projects);
        }
    }
}
