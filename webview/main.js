(function () {
    const vscode = acquireVsCodeApi();

    // State
    const previousState = vscode.getState() || {};
    let projects = [];
    let sessions = {};
    let skills = {};
    let globalSkills = undefined;

    let globalSkillsPath = null; // Store global path
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
                console.log('[UI DEBUG] Message Received:', JSON.stringify({
                    hasProjects: !!message.projects,
                    projectsCount: message.projects?.length,
                    hasGlobalSkills: message.globalSkills !== undefined,
                    globalSkillsCount: message.globalSkills?.length,
                    globalSkillsType: typeof message.globalSkills,
                    isArray: Array.isArray(message.globalSkills)
                }));
                let changed = false;

                if (message.projects) {
                    // Check if projects list actually changed to avoid layout thrashing
                    const prevIds = projects.map(p => p.id).join(',');
                    const nextIds = message.projects.map(p => p.id).join(',');
                    if (prevIds !== nextIds || projects.length !== message.projects.length) {
                        projects = message.projects;
                        changed = true;
                        console.log('[UI][DEBUG] Projects list updated, count:', projects.length);
                    } else {
                        // Just update individual project data
                        projects = message.projects;
                    }
                }

                if (message.sessions) {
                    const nextSessions = JSON.stringify(message.sessions);
                    if (JSON.stringify(sessions) !== nextSessions) {
                        sessions = message.sessions; // DIRECT OVERWRITE (to fix deletion sync)
                        changed = true;
                        console.log('[UI][DEBUG] Sessions updated');
                    }
                }

                if (message.skills) {
                    const nextSkills = JSON.stringify(message.skills);
                    if (JSON.stringify(skills) !== nextSkills) {
                        skills = message.skills; // DIRECT OVERWRITE (to fix deletion sync)
                        changed = true;
                        console.log('[UI][DEBUG] Skills updated');
                    }
                }

                if (message.globalSkills !== undefined) {
                    const nextGlobal = JSON.stringify(message.globalSkills);
                    if (JSON.stringify(globalSkills) !== nextGlobal) {
                        globalSkills = message.globalSkills;
                        if (message.globalSkillsPath) globalSkillsPath = message.globalSkillsPath;
                        changed = true;
                        console.log('[UI][DEBUG] Global Skills updated');
                    }
                }


                if (message.conversations && message.conversations.length > 0) {
                    // Safety merge: Do not lose workspace paths we already know
                    message.conversations.forEach(newC => {
                        const oldC = allConversations.find(oc => oc.id === newC.id);
                        if (oldC && oldC.workspacePath && !newC.workspacePath) {
                            newC.workspacePath = oldC.workspacePath;
                        }
                    });

                    const nextConvs = JSON.stringify(message.conversations.map(c => c.id + (c.workspacePath || '')));
                    const prevConvs = JSON.stringify(allConversations.map(c => c.id + (c.workspacePath || '')));
                    if (nextConvs !== prevConvs) {
                        allConversations = message.conversations;
                        changed = true;
                        console.log('[UI] Conversations data changed');
                    }
                }

                if (message.activeProjectPath !== undefined && activeProjectPath !== message.activeProjectPath) {
                    activeProjectPath = message.activeProjectPath;
                    changed = true;
                }

                // Only render if something meaningful changed
                if (changed) {
                    console.log('[UI] Scheduling renderProjects due to changes');
                    debouncedRenderProjects();
                }
                break;
            case 'usageUpdate':
                quotaGroups = message.groups || [];
                // Update status if provided
                if (message.status) {
                    console.log('[UI] Connection status:', message.status);
                    const statusEl = document.getElementById('connection-status');
                    if (statusEl) statusEl.textContent = message.status;
                }
                // Default to first group if no selection
                if (!selectedGroupId && quotaGroups.length > 0) {
                    selectedGroupId = quotaGroups[0].id;
                }
                renderUsage();
                break;

            case 'conversationsUpdate':
                console.log('[UI] Conversations update received:', message.conversations?.length);
                if (message.conversations && message.conversations.length > 0) {
                    let hasNewPath = false;
                    message.conversations.forEach(newC => {
                        const oldC = allConversations.find(oc => oc.id === newC.id);
                        if (newC.workspacePath) {
                            if (!oldC || oldC.workspacePath !== newC.workspacePath) {
                                hasNewPath = true;
                            }
                        }
                        if (oldC && oldC.workspacePath && !newC.workspacePath) {
                            newC.workspacePath = oldC.workspacePath;
                        }
                    });

                    if (hasNewPath || allConversations.length !== message.conversations.length) {
                        allConversations = message.conversations;
                        console.log('[UI] Conversations enriched with new paths, scheduling render');
                        debouncedRenderProjects();
                    }
                }
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
        <div class="ctx-item" id="ctx-open-current">
            <svg class="ctx-icon" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            Open in Current Window
        </div>
        <div class="ctx-item" id="ctx-open-new">
            <svg class="ctx-icon" viewBox="0 0 24 24"><path d="M21 3h-6m6 0v6m0-6L14 10"></path><rect x="3" y="11" width="18" height="10" rx="2"></rect></svg>
            Open in New Window
        </div>
        <div class="ctx-item" id="ctx-separator" style="height:1px; background:var(--border-color); margin:4px 0; display:none;"></div>
        <div class="ctx-item" id="ctx-apply-skill" style="display:none;">
            <svg class="ctx-icon" viewBox="0 0 24 24"><path d="M4 17l6-6-6-6"></path><path d="M12 19h8"></path></svg>
            Apply Skill
        </div>
        <div class="ctx-item" id="ctx-delete-skill" style="display:none; color:var(--color-danger);">
            <svg class="ctx-icon" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete Skill
        </div>
        <div class="ctx-item" id="ctx-reveal">
            <svg class="ctx-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            Reveal in Finder
        </div>
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

    document.getElementById('ctx-reveal').addEventListener('click', () => {
        if (ctxMenuTarget) {
            vscode.postMessage({ type: 'revealInOS', path: ctxMenuTarget.path });
            hideCtxMenu();
        }
    });

    document.getElementById('ctx-delete-skill').addEventListener('click', () => {
        if (ctxMenuTarget && ctxMenuTarget.path) {
            vscode.postMessage({ type: 'deleteSkill', path: ctxMenuTarget.path });
            hideCtxMenu();
        }
    });

    document.getElementById('ctx-apply-skill').addEventListener('click', () => {
        if (ctxMenuTarget && ctxMenuTarget.path) {
            vscode.postMessage({ type: 'applySkill', path: ctxMenuTarget.path });
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

        // Helper to find valid target
        const targetEl = e.target.closest('.project-header, .folder-header, .file-item');

        if (targetEl) {
            // Priority: data-path (files/folders), or project path from data-path
            // Note: renderSkills adds data-path to file-item. We need to ensure folder-header has it too.
            // Project header has data-path.

            const path = targetEl.getAttribute('data-path') || targetEl.dataset.path;
            const id = targetEl.getAttribute('data-id') || targetEl.dataset.target; // ID might technically be optional for pure file reveal

            if (path) {
                console.log('[UI] Context Menu on:', path);
                ctxMenuTarget = { id, path };

                // Determine type for menu items
                const isGlobalHeader = targetEl.classList.contains('project-header') && targetEl.getAttribute('data-id') === 'global-skills';
                const isNormalProject = targetEl.classList.contains('project-header') && !isGlobalHeader;
                const isSkillRoot = targetEl.getAttribute('data-is-skill') === 'true';

                // Toggle visibility based on type
                const itemOpenCurrent = document.getElementById('ctx-open-current');
                const itemOpenNew = document.getElementById('ctx-open-new');
                const itemSeparator = document.getElementById('ctx-separator');
                const itemApply = document.getElementById('ctx-apply-skill');
                const itemDelete = document.getElementById('ctx-delete-skill');

                if (isNormalProject) {
                    itemOpenCurrent.style.display = 'flex';
                    itemOpenNew.style.display = 'flex';
                    itemSeparator.style.display = 'none';
                    itemApply.style.display = 'none';
                    itemDelete.style.display = 'none';
                } else {
                    // Global Skills header, sub-folders, files -> Open Hidden
                    itemOpenCurrent.style.display = 'none';
                    itemOpenNew.style.display = 'none';

                    if (isSkillRoot) {
                        itemSeparator.style.display = 'none'; // No separator at top
                        itemApply.style.display = 'flex';
                        itemDelete.style.display = 'flex';
                    } else {
                        itemSeparator.style.display = 'none';
                        itemApply.style.display = 'none';
                        itemDelete.style.display = 'none';
                    }
                }

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

    // Debounce renderProjects to batch multiple updates (especially during initialization)
    function debounceRender(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    const debouncedRenderProjects = debounceRender(renderProjects, 100);

    function renderProjects() {
        if (!projectListEl) return;

        try {
            // 1. Render Global Skills Section
            let globalEl = projectListEl.querySelector('.global-section');
            if (globalSkills) {
                if (!globalEl) {
                    globalEl = document.createElement('div');
                    globalEl.className = 'project-item global-section';
                    globalEl.style.marginBottom = '8px'; // Reduced from 24px
                    projectListEl.prepend(globalEl);
                }

                // Re-render header and content cleanly
                globalEl.innerHTML = '';

                const header = document.createElement('div');
                header.className = 'project-header';
                header.dataset.id = 'global-skills';
                if (globalSkillsPath) header.dataset.path = globalSkillsPath; // Add path for context menu
                header.style.cursor = 'pointer';
                header.style.paddingBottom = '4px';

                // Re-calculate expansion state
                const isExpanded = expandedProjects.has('global-skills');

                // Removed arrow as requested
                // Add invisible arrow for alignment - Strict Structure Matching
                // Project headers use empty span for arrow (no text content), so we do the same.
                header.innerHTML = `
                    <span class="folder-arrow"></span>
                    <span class="dot red-global"></span>
                    <span class="project-name">Global Skills</span>
                `;

                // Attach safe listener
                header.onclick = (e) => {
                    e.stopPropagation();
                    console.log('[UI] Toggling Global Skills');
                    toggleProjectExpansion('global-skills');
                };

                const content = document.createElement('div');
                content.className = `project-content ${isExpanded ? '' : 'collapsed'}`;

                const innerContent = document.createElement('div');
                innerContent.className = 'skills-content';
                // mimic .folder-container styles exactly for alignment
                innerContent.style.marginLeft = '4px';
                innerContent.style.paddingLeft = '8px';
                innerContent.style.borderLeft = '1px solid var(--border-color)';

                const hasSkills = globalSkills.length > 0;
                if (hasSkills) {
                    innerContent.innerHTML = renderSkills(globalSkills, 'global', 0);
                    // Attach click listeners for files
                    innerContent.querySelectorAll('.file-item').forEach(el => {
                        el.onclick = (e) => {
                            e.stopPropagation();
                            console.log('[UI] Opening Global Skill file:', el.dataset.path);
                            // Use dataset.path as set in renderSkills
                            vscode.postMessage({ type: 'openFile', path: el.dataset.path });
                        };
                    });
                } else {
                    innerContent.innerHTML = '<div class="folder-empty">No global skills found</div>';
                }

                content.appendChild(innerContent);
                globalEl.appendChild(header);
                globalEl.appendChild(content);

            } else if (globalEl) {
                globalEl.remove();
            }
        } catch (e) {
            console.error('[UI] Error rendering Global Skills:', e);
        }

        const projectStartIndex = globalSkills ? 1 : 0;

        // 2. Render Normal Projects
        if (projects.length === 0) {
            console.log('[UI][renderProjects] projects count is 0');
            // Only show "No Projects" empty state if globalSkills hasn't been initialized yet
            // If globalSkills is defined (even if empty []), we show the Global Skills header, so we don't show the full-page empty state.
            if (globalSkills === undefined) {
                projectListEl.innerHTML = '<div class="empty-state">No projects yet.<br>Click + above to add one.</div>';
                return;
            }
            // If we have globalSkills (even empty), we CONTINUE rendering so the header appears.
        }

        console.log('[UI][renderProjects] Rendering', projects.length, 'projects');

        // 0. Remove empty state if present
        const emptyState = projectListEl.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        const currentIds = new Set(projects.map(p => p.id));
        console.log('[UI][renderProjects] Project IDs:', Array.from(currentIds));

        // 1. Remove projects that are no longer present
        // 1. Remove projects that are no longer present
        Array.from(projectListEl.children).forEach(child => {
            // Ignore global section
            if (child.classList.contains('global-section')) return;

            // If it's a project item (has data-container-id) and not in current list
            const id = child.getAttribute('data-container-id');
            if (id && !currentIds.has(id)) {
                child.remove();
            }
        });

        // 2. Update or Create projects
        projects.forEach((project, index) => {
            let projectEl = projectListEl.querySelector(`.project-item[data-container-id="${project.id}"]`);

            if (projectEl) {
                updateProjectElement(projectEl, project);
            } else {
                projectEl = createProjectElement(project);
            }

            // Only move if not in correct position to avoid layout thrashing/flickering
            const targetIndex = projectStartIndex + index;
            if (projectListEl.children[targetIndex] !== projectEl) {
                if (targetIndex >= projectListEl.children.length) {
                    projectListEl.appendChild(projectEl);
                } else {
                    projectListEl.insertBefore(projectEl, projectListEl.children[targetIndex]);
                }
            }
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
        const newClassName = 'project-item' + (isActive ? ' active' : '');
        if (container.className !== newClassName) {
            container.className = newClassName;
        }

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
        // Only update if expanded to avoid background work and flickering
        if (isChatsExpanded) {
            renderChatsInner(chatsContentDiv, project, allConversations);
        } else {
            // Keep it empty or minimal if collapsed
            if (chatsContentDiv.innerHTML !== '') {
                // optional: chatsContentDiv.innerHTML = '';
            }
        }


        // --- Skills Folder ---
        const skillsContentId = `content-skills-${project.id}`;
        let skillsContainer = contentEl.querySelector(`.folder-container[data-type="skills"]`);

        // Construct standard skills path
        // We assume usage of forward slashes for internal path consistency or simple concatenation
        // Since we are on Mac as per meta, this is safe.
        const skillsPath = (project.path || '').replace(/\/$/, '') + '/.agent/skills';

        if (!skillsContainer) {
            skillsContainer = document.createElement('div');
            skillsContainer.className = 'folder-container';
            skillsContainer.setAttribute('data-type', 'skills');
            skillsContainer.innerHTML = `
                <div class="folder-header" data-target="${skillsContentId}" data-path="${skillsPath}">
                    <span class="folder-arrow">▼</span>
                    <span>Skills</span>
                </div>
                <div id="${skillsContentId}" class="folder-content"></div>
            `;
            contentEl.appendChild(skillsContainer);
        } else {
            // Update path if exists (in case project path weirdly changed or init timing)
            const hdr = skillsContainer.querySelector('.folder-header');
            if (hdr) hdr.setAttribute('data-path', skillsPath);
        }

        // Update Skills State
        const isSkillsExpanded = expandedFolders.has(skillsContentId);
        const skillsArrow = skillsContainer.querySelector('.folder-arrow');
        const skillsContentDiv = skillsContainer.querySelector(`#${skillsContentId}`);

        skillsArrow.className = 'folder-arrow' + (isSkillsExpanded ? '' : ' collapsed');
        skillsContentDiv.className = 'folder-content' + (isSkillsExpanded ? '' : ' collapsed');

        // Update Skills Content
        if (isSkillsExpanded) {
            const projectSkills = skills[project.id];
            // We re-render skills. renderSkills returns HTML string.
            if (projectSkills && projectSkills.length > 0) {
                const newSkillsHtml = renderSkills(projectSkills, project.id, 0);
                if (skillsContentDiv.innerHTML !== newSkillsHtml) {
                    console.log(`[UI] Updating Skills content for ${project.name}`);
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
    }

    function renderChatsInner(container, project, allConvos) {
        if (!allConvos || allConvos.length === 0) {
            container.innerHTML = '<div class="folder-empty">No active chats</div>';
            return;
        }

        // 1. Try to find matching convos
        function normalizePath(p) {
            if (!p) return '';
            // Handle file:// protocol, normalize slashes, and lowercase for robust comparison
            return decodeURIComponent(p.replace(/^file:\/\//, ''))
                .replace(/\\/g, '/')
                .replace(/\/$/, '')
                .toLowerCase();
        }

        const projectPathNorm = normalizePath(project.path);

        let projectConvos = allConvos.filter(c => {
            if (!c.workspacePath) return false;
            const convoPathNorm = normalizePath(c.workspacePath);
            // Use includes for better compatibility with partial paths from backend,
            // but ensure it's a meaningful match
            return convoPathNorm === projectPathNorm ||
                convoPathNorm.indexOf(projectPathNorm + '/') !== -1 ||
                projectPathNorm.indexOf(convoPathNorm) !== -1;
        });

        let isFallback = false;
        if (projectConvos.length === 0) {
            // Fallback: If this is the ACTIVE project, show all recent chats that DON'T belong elsewhere
            const isActive = activeProjectPath && (normalizePath(activeProjectPath) === projectPathNorm);
            if (isActive) {
                // To avoid duplication, we could filter out conversations that are matched by other projects
                // but for simplicity and speed, we'll just show the latest 5
                projectConvos = allConvos.slice(0, 5);
                isFallback = true;
            }
        }

        if (projectConvos.length === 0) {
            container.innerHTML = '<div class="folder-empty">No associated chats</div>';
            return;
        }


        const limit = 10;
        const currentConvos = projectConvos.slice(0, limit);

        // Surgical update: use a hash that includes ID, Title, Time AND Path
        // to detect when enrichment finishes or time updates.
        const structureHash = currentConvos.map(c => `${c.id}-${c.title}-${c.timeAgo}-${c.workspacePath || ''}`).join('|');
        if (container.getAttribute('data-structure-hash') === structureHash) {
            return;
        }
        container.setAttribute('data-structure-hash', structureHash);

        let html = '';
        currentConvos.forEach(convo => {
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

        container.innerHTML = html;
        // Add listeners
        container.querySelectorAll('.conversation-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                const cid = item.getAttribute('data-id');
                vscode.postMessage({
                    type: 'handleChatClick',
                    cascadeId: cid,
                    projectPath: project.path
                });
            };
        });
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
                // Top level folders (depth 0) marked as Skill Roots
                const isSkillAttr = depth === 0 ? 'data-is-skill="true"' : '';

                html += `
                    <div class="skill-item">
                        <div class="folder-header" data-target="${uniqueId}" data-path="${node.path}" ${isSkillAttr}>
                            <span class="folder-arrow ${isExpanded ? '' : 'collapsed'}">▼</span>
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

                        // Trigger re-render to load data for newly expanded folder
                        renderProjects();
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
