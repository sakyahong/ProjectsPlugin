const fs = require('fs');
const path = require('path');
const os = require('os');

async function scanDirectory(dirPath) {
    try {
        const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const nodes = [];

        for (const dirent of dirents) {
            if (dirent.name.startsWith('.')) continue;

            const fullPath = path.join(dirPath, dirent.name);
            if (dirent.isDirectory()) {
                nodes.push({
                    name: dirent.name,
                    type: 'directory',
                    path: fullPath,
                    children: await scanDirectory(fullPath)
                });
            } else {
                nodes.push({
                    name: dirent.name,
                    type: 'file',
                    path: fullPath
                });
            }
        }
        return nodes;
    } catch (error) {
        console.error(`Error scanning ${dirPath}:`, error);
        return [];
    }
}

async function main() {
    const globalPath = path.join(os.homedir(), '.gemini/skills');
    console.log('Scanning path:', globalPath);

    if (!fs.existsSync(globalPath)) {
        console.log('Path does not exist!');
        return;
    }

    const skills = await scanDirectory(globalPath);
    console.log('Found skills:', JSON.stringify(skills, null, 2));
}

main();
