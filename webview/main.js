(function () {
    const vscode = acquireVsCodeApi();

    // State
    const previousState = vscode.getState() || {};
    let projects = [];
    let sessions = {};
    let skills = {};
    let conversations = {};  // Map of projectPath -> conversations array
    let allConversations = [];  // All conversations (for global display)
    let quotaGroups = [];
    let selectedGroupId = previousState.selectedGroupId || null;
    // Track expanded folder IDs (Set of strings)
    let expandedFolders = new Set(previousState.expandedFolders || []);

    function saveState() {
        vscode.setState({
            selectedGroupId: selectedGroupId,
            expandedFolders: Array.from(expandedFolders)
        });
    }

    // Helper to generate stable IDs from strings
    function getStableId(prefix, str) {
        // Simple hash or b64
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return `${prefix}-${Math.abs(hash)}`;
    }

    // Event Delegation for Folders
    // This block will be initialized after elements are defined.
    // Elements
    const projectListEl = document.getElementById('project-list');
    const conversationsListEl = document.getElementById('conversations-list');
    const usageGroupsEl = document.getElementById('usage-groups');
    const usageListEl = document.getElementById('usage-list');
    const usageHeaderRow = document.getElementById('usage-header-row');
    const toggleIcon = document.getElementById('toggle-icon');

    // Toggle Expand
    if (usageHeaderRow) {
        usageHeaderRow.addEventListener('click', () => {
            const isVisible = usageListEl.classList.contains('visible');
            if (isVisible) {
                usageListEl.classList.remove('visible');
                toggleIcon.classList.remove('expanded');
            } else {
                usageListEl.classList.add('visible');
                toggleIcon.classList.add('expanded');
            }
        });
    }

    // Handle messages
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'update':
                projects = message.projects;
                sessions = message.sessions;
                if (message.skills) {
                    skills = message.skills;
                }
                renderProjects();
                break;
            case 'usageUpdate':
                quotaGroups = message.groups || [];
                // Default to first group if no selection
                if (!selectedGroupId && quotaGroups.length > 0) {
                    selectedGroupId = quotaGroups[0].id;
                }
                renderUsage();
                break;
            case 'conversationsUpdate':
                allConversations = message.conversations || [];
                renderConversations();
                renderProjects(); // Also re-render projects to update grouped conversations
                break;
        }
    });

    // Initial Load
    vscode.postMessage({ type: 'onLoad' });

    function getRemainingColor(remaining) {
        if (remaining >= 60) return 'var(--color-safe)';      // Green >= 60%
        if (remaining >= 30) return 'var(--color-warning)';   // Orange 30-60%
        return 'var(--color-danger)';                         // Red < 30%
    }

    function formatDate(dateStr) {
        if (!dateStr) return '--';
        try {
            const date = new Date(dateStr);
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            const hours = date.getHours().toString().padStart(2, '0');
            const mins = date.getMinutes().toString().padStart(2, '0');
            return `${month}-${day} ${hours}:${mins}`;
        } catch {
            return '--';
        }
    }

    function renderUsage() {
        if (!quotaGroups || quotaGroups.length === 0) return;

        // Find selected group
        const selectedGroup = quotaGroups.find(g => g.id === selectedGroupId) || quotaGroups[0];

        // --- Render Selected Group in Header (Collapsed View) ---
        if (usageGroupsEl) {
            const remaining = Math.min(100, Math.max(0, selectedGroup.remaining));
            const color = getRemainingColor(remaining);

            usageGroupsEl.innerHTML = `
                <div class="usage-group-item active-group">
                    <div class="group-header">
                        <span class="group-name">${selectedGroup.name}</span>
                        <span class="group-reset">${formatDate(selectedGroup.resetDate)}</span>
                    </div>
                    <div class="group-bar-row">
                        <div class="group-bar-container">
                            <div class="usage-segment" style="width: ${remaining}%; background-color: ${color}"></div>
                        </div>
                        <span class="group-percent" style="color: ${color}">${remaining}%</span>
                    </div>
                </div>
            `;
        }

        // --- Render All Groups in Expandable Details ---
        if (usageListEl) {
            // Only render details if needed, to avoid wiping selection handlers if re-rendering carelessly
            // But currently renderUsage is called on update so we must re-render.
            usageListEl.innerHTML = '';

            quotaGroups.forEach(group => {
                const remaining = Math.min(100, Math.max(0, group.remaining));
                const color = getRemainingColor(remaining);
                const isSelected = group.id === selectedGroupId;

                const groupEl = document.createElement('div');
                groupEl.className = 'usage-group-row' + (isSelected ? ' selected' : '');
                groupEl.innerHTML = `
                    <div class="group-header">
                        <span class="group-name">${group.name}</span>
                        <span style="color: ${color}">${remaining}%</span>
                    </div>
                    <div class="group-bar-row">
                        <div class="group-bar-container">
                            <div class="usage-segment" style="width: ${remaining}%; background-color: ${color}"></div>
                        </div>
                    </div>
                `;

                // Click to select this group
                groupEl.addEventListener('click', () => {
                    selectedGroupId = group.id;
                    saveState(); // Persist selection
                    renderUsage();
                    // Collapse after selection
                    usageListEl.classList.remove('visible');
                    toggleIcon.classList.remove('expanded');
                });

                usageListEl.appendChild(groupEl);

                // Show individual models under each group
                group.models.forEach(model => {
                    const modelRemaining = Math.min(100, Math.max(0, model.remaining));
                    const modelColor = getRemainingColor(modelRemaining);

                    const modelEl = document.createElement('div');
                    modelEl.className = 'usage-item-row';
                    modelEl.innerHTML = `
                        <div class="usage-item-header">
                            <span>${model.name}</span>
                            <span style="color: ${modelColor}">${modelRemaining}%</span>
                        </div>
                        <div class="usage-item-bar">
                            <div class="usage-segment" style="width: ${modelRemaining}%; background-color: ${modelColor}"></div>
                        </div>
                    `;
                    usageListEl.appendChild(modelEl);
                });
            });
        }
    }

    function renderProjects() {
        projectListEl.innerHTML = '';

        if (projects.length === 0) {
            projectListEl.innerHTML = '<div class="empty-state">No projects yet.<br>Click + above to add one.</div>';
            return;
        }

        projects.forEach(project => {
            const projectContainer = document.createElement('div');
            projectContainer.className = 'project-item';

            // --- Project Header ---
            const headerEl = document.createElement('div');
            headerEl.className = 'project-header';

            const nameEl = document.createElement('div');
            nameEl.className = 'project-name';
            // Add Green Dot
            nameEl.innerHTML = `<span class="dot green"></span>${project.name}`;

            nameEl.onclick = () => {
                vscode.postMessage({ type: 'openProject', path: project.path, id: project.id });
            };
            headerEl.appendChild(nameEl);

            const deleteBtn = document.createElement('div');
            deleteBtn.className = 'delete-btn';
            deleteBtn.textContent = '×';
            deleteBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                vscode.postMessage({ type: 'deleteProject', id: project.id });
            };
            headerEl.appendChild(deleteBtn);
            projectContainer.appendChild(headerEl);

            // --- Chats Folder ---
            const chatContentId = `content-chats-${project.id}`;
            const isChatsExpanded = expandedFolders.has(chatContentId);

            const chatsContainer = document.createElement('div');
            chatsContainer.className = 'folder-container';

            // Header: Default Collapsed
            chatsContainer.innerHTML = `
                <div class="folder-header" data-target="${chatContentId}">
                    <span class="folder-arrow ${isChatsExpanded ? '' : 'collapsed'}">▼</span>
                    <span>Chats</span>
                </div>
                <div id="${chatContentId}" class="folder-content ${isChatsExpanded ? '' : 'collapsed'}"></div>
            `;
            const chatsContentEl = chatsContainer.querySelector(`#${chatContentId}`);

            // Filter Conversations
            const projectConvos = allConversations.filter(c => {
                if (!c.workspacePath) return false;
                const normC = decodeURIComponent(c.workspacePath.replace(/^file:\/\//, '')).toLowerCase();
                const normP = decodeURIComponent(project.path.replace(/^file:\/\//, '')).toLowerCase();
                return normC.includes(normP);
            });

            if (projectConvos.length > 0) {
                projectConvos.slice(0, 10).forEach(convo => {
                    const item = document.createElement('div');
                    item.className = 'conversation-item sub-item';
                    item.innerHTML = `
                        <div style="display:flex; align-items:center; overflow:hidden;">
                            <span class="dot red"></span>
                            <span class="convo-title" title="${convo.title}">${convo.title || 'Untitled'}</span>
                        </div>
                        <span class="convo-time">${convo.timeAgo}</span>
                    `;
                    item.onclick = (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'openConversation', cascadeId: convo.id });
                    };
                    chatsContentEl.appendChild(item);
                });
            } else {
                chatsContentEl.innerHTML = '<div class="folder-empty">No active chats</div>';
            }
            projectContainer.appendChild(chatsContainer);

            // --- Skills Folder ---
            const skillsContainer = document.createElement('div');
            skillsContainer.className = 'folder-container';
            const skillsContentId = `content-skills-${project.id}`;
            const isSkillsExpanded = expandedFolders.has(skillsContentId);
            // Remove onclick, use data-target
            skillsContainer.innerHTML = `
                <div class="folder-header" data-target="${skillsContentId}">
                    <span class="folder-arrow ${isSkillsExpanded ? '' : 'collapsed'}">▼</span>
                    <span>Skills</span>
                </div>
                <div id="${skillsContentId}" class="folder-content ${isSkillsExpanded ? '' : 'collapsed'}"></div>
            `;
            const skillsContentEl = skillsContainer.querySelector(`#${skillsContentId}`);

            const projectSkills = skills[project.id];
            if (projectSkills && projectSkills.length > 0) {
                skillsContentEl.innerHTML = renderSkills(projectSkills, project.id, 0);
            } else {
                skillsContentEl.innerHTML = '<div class="folder-empty">No skills found</div>';
            }
            projectContainer.appendChild(skillsContainer);

            projectListEl.appendChild(projectContainer);
        });
    }

    // Recursive function to render skills tree
    function renderSkills(nodes, projectId, depth) {
        let html = '';
        if (!nodes || nodes.length === 0) return html;

        nodes.forEach(node => {
            if (node.type === 'directory') {
                const uniqueId = getStableId(`skill-${projectId}`, node.path);
                const isExpanded = expandedFolders.has(uniqueId);
                // Top level folders (depth 0) get the Blue Dot
                const dotHtml = depth === 0 ? '<span class="dot blue"></span>' : '';

                html += `
                    <div class="skill-item">
                        <div class="folder-header" data-target="${uniqueId}" style="padding-left: 0;">
                            <span class="folder-arrow ${isExpanded ? '' : 'collapsed'}">▼</span>
                            ${dotHtml}
                            <span>${node.name}</span>
                        </div>
                        <div id="${uniqueId}" class="folder-content ${isExpanded ? '' : 'collapsed'}" style="margin-left: 12px; border-left: 1px solid var(--border-color);">
                            ${renderSkills(node.children, projectId, depth + 1)}
                        </div>
                    </div>
                `;
            } else {
                // File item
                html += `
                    <div class="file-item" style="padding: 2px 0 2px 18px; font-size: 11px; color: var(--muted-text);">
                        ${node.name}
                    </div>
                `;
            }
        });
        return html;
    }


    if (projectListEl) {
        projectListEl.addEventListener('click', (e) => {
            // Check if clicked element is a folder header or inside one
            const header = e.target.closest('.folder-header');
            if (header) {
                const targetId = header.getAttribute('data-target');
                const content = document.getElementById(targetId);
                const arrow = header.querySelector('.folder-arrow');

                if (content && arrow) {
                    if (content.classList.contains('collapsed')) {
                        content.classList.remove('collapsed');
                        arrow.classList.remove('collapsed');
                        expandedFolders.add(targetId); // Track expansion
                    } else {
                        content.classList.add('collapsed');
                        arrow.classList.add('collapsed');
                        expandedFolders.delete(targetId); // Track collapse
                    }
                    saveState(); // Persist changes
                }
            }
        });
    }

    function renderConversations() {
        if (!conversationsListEl) return;
        conversationsListEl.innerHTML = '';
        conversationsListEl.style.display = 'none';
    }
})();
