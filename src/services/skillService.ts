import * as fs from 'fs';
import * as path from 'path';

export interface SkillNode {
    name: string;
    type: 'file' | 'directory';
    path: string;
    children?: SkillNode[];
}

export class SkillService {
    /*
     * Scans the project for .agent/skills and returns a structure of skills.
     */
    async getSkillsForProject(projectPath: string): Promise<SkillNode[]> {
        const agentDirPath = path.join(projectPath, '.agent');
        if (!fs.existsSync(agentDirPath)) {
            return [];
        }

        try {
            const items = await fs.promises.readdir(agentDirPath);
            // Case-insensitive search for 'skills' directory
            const skillsDir = items.find(item => item.toLowerCase() === 'skills');

            if (!skillsDir) {
                return [];
            }

            const fullPath = path.join(agentDirPath, skillsDir);
            const stats = await fs.promises.stat(fullPath);
            if (!stats.isDirectory()) {
                return [];
            }

            return this.getSkillsFromPath(fullPath);
        } catch (error) {
            console.error(`Error scanning for skills in ${projectPath}:`, error);
            return [];
        }
    }


    async getSkillsFromPath(fullPath: string): Promise<SkillNode[]> {
        if (!fs.existsSync(fullPath)) {
            return [];
        }

        try {
            const dirents = await fs.promises.readdir(fullPath, { withFileTypes: true });
            const nodes: SkillNode[] = [];

            for (const dirent of dirents) {
                if (dirent.name.startsWith('.')) continue;

                const nodePath = path.join(fullPath, dirent.name);
                if (dirent.isDirectory()) {
                    nodes.push({
                        name: dirent.name,
                        type: 'directory',
                        path: nodePath,
                        children: await this.scanDirectory(nodePath)
                    });
                } else {
                    nodes.push({
                        name: dirent.name,
                        type: 'file',
                        path: nodePath
                    });
                }
            }

            nodes.sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name);
                return a.type === 'directory' ? -1 : 1;
            });

            return nodes;
        } catch (error) {
            console.error(`Error scanning skills path ${fullPath}:`, error);
            return [];
        }
    }

    private async scanDirectory(dirPath: string): Promise<SkillNode[]> {
        try {
            const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
            const nodes: SkillNode[] = [];

            for (const dirent of dirents) {
                if (dirent.name.startsWith('.')) continue;

                const fullPath = path.join(dirPath, dirent.name);
                if (dirent.isDirectory()) {
                    nodes.push({
                        name: dirent.name,
                        type: 'directory',
                        path: fullPath,
                        children: await this.scanDirectory(fullPath)
                    });
                } else {
                    nodes.push({
                        name: dirent.name,
                        type: 'file',
                        path: fullPath
                    });
                }
            }

            nodes.sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name);
                return a.type === 'directory' ? -1 : 1;
            });

            return nodes;
        } catch (error) {
            console.error(`Error scanning directory ${dirPath}:`, error);
            return [];
        }
    }
}
