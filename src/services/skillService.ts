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
     * The structure is a list of root folders (The "Skills").
     * Each root folder contains the full file tree.
     */
    async getSkillsForProject(projectPath: string): Promise<SkillNode[]> {
        let skillsDirName = '.agent/skills';
        let fullPath = path.join(projectPath, skillsDirName);

        if (!fs.existsSync(fullPath)) {
            skillsDirName = '.agent/Skills';
            fullPath = path.join(projectPath, skillsDirName);
            if (!fs.existsSync(fullPath)) {
                return [];
            }
        }

        try {
            // Get top level directories (The "Skills")
            const dirents = await fs.promises.readdir(fullPath, { withFileTypes: true });
            const skillFolders = dirents.filter(d => d.isDirectory());

            const skills: SkillNode[] = [];
            for (const folder of skillFolders) {
                const skillName = folder.name;
                const skillPath = path.join(fullPath, skillName);

                const children = await this.scanDirectory(skillPath);

                skills.push({
                    name: skillName,
                    type: 'directory',
                    path: skillPath,
                    children: children
                });
            }

            return skills;
        } catch (error) {
            console.error(`Error scanning skills for ${projectPath}:`, error);
            return [];
        }
    }

    private async scanDirectory(dirPath: string): Promise<SkillNode[]> {
        try {
            const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
            const nodes: SkillNode[] = [];

            for (const dirent of dirents) {
                // Ignore hidden files
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

            // Sort: Directories first, then files
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
