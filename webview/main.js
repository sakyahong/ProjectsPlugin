(function () {
    const vscode = acquireVsCodeApi();

    // State
    const previousState = vscode.getState() || {};
    let projects = [];
    let sessions = {};
    let skills = {};
    let activeProjectPath = null;
    let conversations = {};  // Map of projectPath -> conversations array
    let allConversations = [];  // All conversations (for global display)
    let quotaGroups = [];
    let selectedGroupId = previousState.selectedGroupId || null;
    // Track expanded folder IDs (Set of strings)
    let expandedFolders = new Set(previousState.expandedFolders || []);
    // Track expanded projects (Set of strings) - Default empty means all collapsed
    let expandedProjects = new Set(previousState.expandedProjects || []);

    function saveState() {
        vscode.setState({
            selectedGroupId: selectedGroupId,
            expandedFolders: Array.from(expandedFolders),
            expandedProjects: Array.from(expandedProjects)
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
                // console.log('UI Update received:', message.projects.length, 'projects');
                projects = message.projects;
                sessions = message.sessions;
                if (message.skills) {
                    skills = message.skills;
                }
                if (message.activeProjectPath !== undefined) {
                    activeProjectPath = message.activeProjectPath;
                }
                renderProjects(); // Seamless re-render
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
                        <div style="display:flex; flex-direction:column; align-items:flex-end;">
                            <span style="color: ${color}">${remaining}%</span>
                            <span class="group-reset" style="font-size:9px; color:var(--muted-text);">${formatDate(group.resetDate)}</span>
                        </div>
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

    // --- Context Menu Logic ---
    let ctxMenuTarget = null; // { id, path }
    const ctxMenuEl = document.createElement('div');
    ctxMenuEl.className = 'ctx-menu';
    ctxMenuEl.innerHTML = `
        <div class="ctx-item" id="ctx-open-current">Open in Current Window</div>
        <div class="ctx-item" id="ctx-open-new">Open in New Window</div>
    `;
    document.body.appendChild(ctxMenuEl);

    document.getElementById('ctx-open-current').addEventListener('click', () => {
        if (ctxMenuTarget) {
            vscode.postMessage({ type: 'openProject', path: ctxMenuTarget.path, id: ctxMenuTarget.id, newWindow: false });
            hideCtxMenu();
        }
    });

    document.getElementById('ctx-open-new').addEventListener('click', () => {
        if (ctxMenuTarget) {
            vscode.postMessage({ type: 'openProject', path: ctxMenuTarget.path, id: ctxMenuTarget.id, newWindow: true });
            hideCtxMenu();
        }
    });

    function hideCtxMenu() {
        ctxMenuEl.classList.remove('visible');
        ctxMenuTarget = null;
    }

    // Global Context Menu Delegation (Rigid - Capture Phase)
    window.addEventListener('contextmenu', (e) => {
        // ALWAYS prevent default immediately in capture phase
        e.preventDefault();
        e.stopPropagation();

        const header = e.target.closest('.project-header');

        if (header) {
            const id = header.getAttribute('data-id');
            const path = header.getAttribute('data-path');

            if (id && path) {
                ctxMenuTarget = { id, path };

                // Adjust position to stay in bounds
                const x = Math.min(e.clientX, window.innerWidth - 180);
                const y = Math.min(e.clientY, window.innerHeight - 80);

                ctxMenuEl.style.top = `${y}px`;
                ctxMenuEl.style.left = `${x}px`;
                ctxMenuEl.classList.add('visible');
                return; // Stop here
            }
        }

        // If we got here, we clicked somewhere else or on a header without data
        hideCtxMenu();
    }, true); // <--- CAPTURE PHASE IS CRITICAL

    // Hide menu on any left click
    window.addEventListener('click', (e) => {
        hideCtxMenu();
    });

    // --- Render Functions ---

    function renderProjects() {
        if (!projectListEl) return;

        if (projects.length === 0) {
            projectListEl.innerHTML = '<div class="empty-state">No projects yet.<br>Click + above to add one.</div>';
            return;
        }

        // Remove empty state if present
        const emptyState = projectListEl.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        const currentIds = new Set(projects.map(p => p.id));

        // 1. Remove projects that are no longer present
        Array.from(projectListEl.children).forEach(child => {
            // If it's a project item (has data-container-id) and not in current list
            const id = child.getAttribute('data-container-id');
            if (id && !currentIds.has(id)) {
                child.remove();
            }
        });

        // 2. Update or Create projects
        projects.forEach(project => {
            let projectEl = projectListEl.querySelector(`.project-item[data-container-id="${project.id}"]`);

            if (projectEl) {
                updateProjectElement(projectEl, project);
            } else {
                projectEl = createProjectElement(project);
                projectListEl.appendChild(projectEl);
            }

            // Re-order by appending (moves existing element to end)
            // This ensures DOM order matches `projects` array order
            projectListEl.appendChild(projectEl);
        });
    }

    function createProjectElement(project) {
        const projectContainer = document.createElement('div');
        projectContainer.className = 'project-item';
        projectContainer.setAttribute('data-container-id', project.id); // For tracking

        updateProjectElement(projectContainer, project);

        return projectContainer;
    }

    function updateProjectElement(container, project) {
        // Determine if active
        let isActive = false;
        if (activeProjectPath && project.path) {
            const normActive = activeProjectPath.toLowerCase();
            const normProject = project.path.toLowerCase();
            isActive = (normActive === normProject) || (normActive.startsWith(normProject + '/')) || (normActive.startsWith(normProject + '\\'));
        }

        // Update wrapper class
        container.className = 'project-item' + (isActive ? ' active' : '');

        // --- Header ---
        let headerEl = container.querySelector('.project-header');
        if (!headerEl) {
            headerEl = document.createElement('div');
            headerEl.className = 'project-header';

            // 1. Arrow
            const arrowEl = document.createElement('span');
            arrowEl.className = 'folder-arrow';
            headerEl.appendChild(arrowEl);

            // 2. Dot
            const dotEl = document.createElement('span');
            dotEl.className = 'dot green';
            headerEl.appendChild(dotEl);

            // 3. Name
            const nameEl = document.createElement('div');
            nameEl.className = 'project-name';
            headerEl.appendChild(nameEl);

            // 4. Delete
            const deleteBtn = document.createElement('div');
            deleteBtn.className = 'delete-btn';
            deleteBtn.textContent = '×';
            headerEl.appendChild(deleteBtn);

            container.appendChild(headerEl); // Add header if new
        }

        // Update Header Data
        headerEl.setAttribute('data-id', project.id);
        headerEl.setAttribute('data-path', project.path);
        headerEl.setAttribute('data-name', project.name);

        // Update Header Content
        const arrowEl = headerEl.querySelector('.folder-arrow');
        const isProjectExpanded = expandedProjects.has(project.id);
        arrowEl.className = 'folder-arrow' + (isProjectExpanded ? '' : ' collapsed');
        // Rebind click to ensure fresh closure if needed, or simple static handling.
        // Better to set onclick once? No, easiest to reset here or check if bound.
        // We'll reset onclick safely.
        arrowEl.onclick = (e) => {
            e.stopPropagation();
            toggleProjectExpansion(project.id);
        };
        headerEl.onclick = (e) => {
            // Prevent if clicking delete btn (handled by capturing logic or specific handler)
            if (e.target.classList.contains('delete-btn')) return;
            toggleProjectExpansion(project.id);
        };

        const nameEl = headerEl.querySelector('.project-name');
        if (nameEl.textContent !== project.name) {
            nameEl.textContent = project.name;
        }

        const deleteBtn = headerEl.querySelector('.delete-btn');
        deleteBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            vscode.postMessage({ type: 'deleteProject', id: project.id });
        };

        // --- Content Wrapper ---
        let contentEl = container.querySelector('.project-content');
        if (!contentEl) {
            contentEl = document.createElement('div');
            container.appendChild(contentEl);
        }
        contentEl.className = 'project-content' + (isProjectExpanded ? '' : ' collapsed');

        // --- Chats Folder ---
        const chatContentId = `content-chats-${project.id}`;
        let chatsContainer = contentEl.querySelector(`.folder-container[data-type="chats"]`);

        if (!chatsContainer) {
            chatsContainer = document.createElement('div');
            chatsContainer.className = 'folder-container';
            chatsContainer.setAttribute('data-type', 'chats');
            chatsContainer.innerHTML = `
                <div class="folder-header" data-target="${chatContentId}">
                    <span class="folder-arrow">▼</span>
                    <span>Chats</span>
                </div>
                <div id="${chatContentId}" class="folder-content"></div>
            `;
            contentEl.appendChild(chatsContainer);
        }

        // Update Chats State
        const isChatsExpanded = expandedFolders.has(chatContentId);
        const chatsArrow = chatsContainer.querySelector('.folder-arrow');
        const chatsContentDiv = chatsContainer.querySelector(`#${chatContentId}`);

        chatsArrow.className = 'folder-arrow' + (isChatsExpanded ? '' : ' collapsed');
        chatsContentDiv.className = 'folder-content' + (isChatsExpanded ? '' : ' collapsed');

        // Update Chats Content
        // We re-render inner HTML here. Since we are inside the 'chatsContentDiv', flickering is minimized.
        // Optimization: checking if conversations actually changed could be done, but simple re-render is usually fine for small lists.
        renderChatsInner(chatsContentDiv, project, allConversations);


        // --- Skills Folder ---
        const skillsContentId = `content-skills-${project.id}`;
        let skillsContainer = contentEl.querySelector(`.folder-container[data-type="skills"]`);

        if (!skillsContainer) {
            skillsContainer = document.createElement('div');
            skillsContainer.className = 'folder-container';
            skillsContainer.setAttribute('data-type', 'skills');
            skillsContainer.innerHTML = `
                <div class="folder-header" data-target="${skillsContentId}">
                    <span class="folder-arrow">▼</span>
                    <span>Skills</span>
                </div>
                <div id="${skillsContentId}" class="folder-content"></div>
            `;
            contentEl.appendChild(skillsContainer);
        }

        // Update Skills State
        const isSkillsExpanded = expandedFolders.has(skillsContentId);
        const skillsArrow = skillsContainer.querySelector('.folder-arrow');
        const skillsContentDiv = skillsContainer.querySelector(`#${skillsContentId}`);

        skillsArrow.className = 'folder-arrow' + (isSkillsExpanded ? '' : ' collapsed');
        skillsContentDiv.className = 'folder-content' + (isSkillsExpanded ? '' : ' collapsed');

        // Update Skills Content
        const projectSkills = skills[project.id];
        // We re-render skills. renderSkills returns HTML string.
        // IMPORTANT: renderSkills logic relies on expandedFolders set, so it should render collapsed/expanded correctly
        // without needing post-render adjustments.
        if (projectSkills && projectSkills.length > 0) {
            const newSkillsHtml = renderSkills(projectSkills, project.id, 0);
            if (skillsContentDiv.innerHTML !== newSkillsHtml) {
                skillsContentDiv.innerHTML = newSkillsHtml;
                // Re-bind click events for files
                skillsContentDiv.querySelectorAll('.file-item').forEach(el => {
                    el.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const filePath = el.getAttribute('data-path');
                        if (filePath) {
                            vscode.postMessage({ type: 'openFile', path: filePath });
                        }
                    });
                });
            }
        } else {
            const emptyHtml = '<div class="folder-empty">No skills found</div>';
            if (skillsContentDiv.innerHTML !== emptyHtml) {
                skillsContentDiv.innerHTML = emptyHtml;
            }
        }
    }

    function renderChatsInner(container, project, allConvos) {
        if (!allConvos || allConvos.length === 0) {
            container.innerHTML = '<div class="folder-empty">No active chats</div>';
            return;
        }

        const projectConvos = allConvos.filter(c => {
            if (!c.workspacePath) return false;
            const normC = decodeURIComponent(c.workspacePath.replace(/^file:\/\//, '')).toLowerCase();
            const normP = decodeURIComponent(project.path.replace(/^file:\/\//, '')).toLowerCase();
            return normC.includes(normP);
        });

        if (projectConvos.length === 0) {
            container.innerHTML = '<div class="folder-empty">No active chats</div>';
            return;
        }

        // Naive re-render for chats (lists are usually small)
        // To be perfect, we'd diff this too, but let's see if this is enough.
        let html = '';
        projectConvos.slice(0, 10).forEach(convo => {
            html += `
                <div class="conversation-item sub-item" data-id="${convo.id}">
                    <div style="display:flex; align-items:center; overflow:hidden;">
                        <span class="dot red"></span>
                        <span class="convo-title" title="${convo.title}">${convo.title || 'Untitled'}</span>
                    </div>
                    <span class="convo-time">${convo.timeAgo}</span>
                </div>
            `;
        });

        if (container.innerHTML !== html) { // Simple string diff check
            container.innerHTML = html;
            // Add listeners
            container.querySelectorAll('.conversation-item').forEach(item => {
                item.onclick = (e) => {
                    e.stopPropagation();
                    const cid = item.getAttribute('data-id'); // We didn't put id on div in string. Fixed now.
                    // Wait, I need to put data-id on the div above.
                    vscode.postMessage({
                        type: 'handleChatClick',
                        cascadeId: cid,
                        projectPath: project.path
                    });
                };
            });
        }
    }

    function toggleProjectExpansion(projectId) {
        if (expandedProjects.has(projectId)) {
            expandedProjects.delete(projectId);
        } else {
            expandedProjects.add(projectId);
        }
        saveState();
        renderProjects();
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
                    <div class="file-item" data-path="${node.path}" style="padding: 2px 0 2px 18px; font-size: 11px; color: var(--muted-text);">
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
