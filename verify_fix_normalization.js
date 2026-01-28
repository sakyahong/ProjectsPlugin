
const conversationService = {
    filterByWorkspace: function (conversations, workspacePath) {
        return conversations.filter(c => {
            if (!c.workspacePath) return false;
            // Normalize paths for comparison
            const normalizePath = (p) => {
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
            if (normalizedWorkspacePath.startsWith(normalizedConvoPath + '/') ||
                normalizedWorkspacePath.startsWith(normalizedConvoPath + '\\')) {
                return true;
            }

            // 3. Parent directory match (Workspace is inside Convo)
            if (normalizedConvoPath.startsWith(normalizedWorkspacePath + '/') ||
                normalizedConvoPath.startsWith(normalizedWorkspacePath + '\\')) {
                return true;
            }

            return false;
        });
    }
};

const tests = [
    {
        name: "Basic Exact Match",
        convoPath: "/Volumes/Data/ProjectA",
        workspacePath: "/Volumes/Data/ProjectA",
        expected: true
    },
    {
        name: "Encoded Space in Convo Path",
        convoPath: "/Volumes/Data/Projects%20Chats",
        workspacePath: "/Volumes/Data/Projects Chats",
        expected: true
    },
    {
        name: "Encoded Space in Workspace Path",
        convoPath: "/Volumes/Data/Projects Chats",
        workspacePath: "/Volumes/Data/Projects%20Chats",
        expected: true
    },
    {
        name: "Case Insensitive Match",
        convoPath: "/Volumes/Data/projecta",
        workspacePath: "/Volumes/Data/ProjectA",
        expected: true
    },
    {
        name: "Strict Match (Reject Prefix)",
        convoPath: "/Volumes/Data/ProjectA_Backup",
        workspacePath: "/Volumes/Data/ProjectA",
        expected: false
    },
    {
        name: "Child Directory",
        convoPath: "/Volumes/Data/ProjectA/src",
        workspacePath: "/Volumes/Data/ProjectA",
        expected: true
    },
    {
        name: "Mixed Slashes",
        convoPath: "\\Volumes\\Data\\ProjectA",
        workspacePath: "/Volumes/Data/ProjectA",
        expected: true
    }
];

console.log("Running Verification Tests for Path Normalization...\n");

let passed = 0;
tests.forEach(test => {
    const result = conversationService.filterByWorkspace([{ workspacePath: test.convoPath }], test.workspacePath).length > 0;
    const status = result === test.expected ? "✅ PASS" : "❌ FAIL";
    console.log(`${status} - ${test.name}`);
    if (result !== test.expected) {
        console.log(`   Expected: ${test.expected}, Got: ${result}`);
        console.log(`   Convo: ${test.convoPath}`);
        console.log(`   Work:  ${test.workspacePath}`);
    } else {
        passed++;
    }
});

console.log(`\nTests Completed: ${passed}/${tests.length} Passed`);
