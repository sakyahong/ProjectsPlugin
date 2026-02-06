(function () {
    const vscode = acquireVsCodeApi();

    // State
    const previousState = vscode.getState() || {};
    let projects = [];
    let sessions = {};
    let skills = {};
    let projectFiles = {};
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

    // Convert any string to a safe CSS ID (for use in querySelector)
    function safeId(str) {
        if (!str) return 'unknown';
        // Use hash-based ID to avoid CSS selector issues with special characters
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return 'id-' + Math.abs(hash).toString(36);
    }


    // Event Delegation for Folders
    // This block will be initialized after elements are defined.
    // Elements
    const projectListEl = document.getElementById('project-list');
    const conversationsListEl = document.getElementById('conversations-list');
    const usageGroupsEl = document.getElementById('usage-groups');
    const usageHeaderRow = document.getElementById('usage-header-row');
    const toggleIcon = document.getElementById('toggle-icon');

    // Toggle Expand
    if (usageHeaderRow) {
        usageHeaderRow.addEventListener('click', () => {
            const isVisible = usageGroupsEl.classList.contains('visible');
            if (isVisible) {
                usageGroupsEl.classList.remove('visible');
                toggleIcon.classList.remove('expanded');
            } else {
                usageGroupsEl.classList.add('visible');
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

                if (message.files) {
                    projectFiles = message.files;
                    changed = true;
                    console.log('[UI][DEBUG] Project files updated');
                }

                if (message.activeProjectPath !== undefined && activeProjectPath !== message.activeProjectPath) {
                    activeProjectPath = message.activeProjectPath;
                    changed = true;
                }

                if (changed) {
                    console.log('[UI] Scheduling renderProjects due to changes');
                    debouncedRenderProjects();
                }
                break;

            case 'filesUpdate':
                if (message.projectId && message.files) {
                    projectFiles[message.projectId] = message.files;
                    console.log('[UI][DEBUG] Partial files updated for:', message.projectId);
                    debouncedRenderProjects();
                }
                break;

            case 'conversationsUpdate':
                if (message.conversations) {
                    // Safety merge: Do not lose workspace paths we already know
                    message.conversations.forEach(newC => {
                        const oldC = allConversations.find(oc => oc.id === newC.id);
                        if (oldC && oldC.workspacePath && !newC.workspacePath) {
                            newC.workspacePath = oldC.workspacePath;
                        }
                    });

                    const nextConvs = JSON.stringify(message.conversations.map(c => c.id + (c.workspacePath || '')));
                    const prevConvs = JSON.stringify(allConversations.map(c => c.id + (c.workspacePath || '')));

                    if (nextConvs !== prevConvs || allConversations.length === 0) {
                        allConversations = message.conversations;
                        console.log('[UI] Conversations data updated:', allConversations.length);
                        debouncedRenderProjects();
                    }
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
        if (remaining >= 60) return 'var(--color-ready)';     // Green >= 60%
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

    // Helper: Get icon and background color for group
    function getGroupStyle(groupId) {
        const styles = {
            'gemini-pro': { icon: '✦', image: geminiIconUri, bg: 'transparent', iconColor: '#fff' },
            'gemini-flash': { icon: '✦', image: geminiIconUri, bg: 'transparent', iconColor: '#ffd700' },
            'claude': { icon: '✷', image: anthropicIconUri, bg: 'transparent', iconColor: '#fff' },
            'gpt': { icon: '⬢', image: openaiIconUri, bg: 'transparent', iconColor: '#fff' },
            'other': { icon: '◈', bg: '#4b5563', iconColor: '#fff' }
        };
        return styles[groupId] || styles['other'];
    }

    // Helper: Get status based on remaining percentage
    function getStatus(remaining) {
        if (remaining >= 60) return { text: 'Ready', class: 'ready' };
        if (remaining >= 30) return { text: 'In Progress', class: 'warning' };
        return { text: 'Break', class: 'danger' };
    }

    // Helper: Generate vertical bars HTML
    function generateBars(remaining, color) {
        const totalBars = 10;
        const filledBars = Math.round(remaining / 10);
        let barsHtml = '';
        for (let i = 0; i < totalBars; i++) {
            const filled = i < filledBars ? 'filled' : '';
            barsHtml += `<div class="usage-bar ${filled}" style="color: ${color}"></div>`;
        }
        return barsHtml;
    }

    function renderUsage() {
        if (!quotaGroups || quotaGroups.length === 0) return;

        // --- Render All Groups as Cards ---
        if (usageGroupsEl) {
            usageGroupsEl.innerHTML = '';

            quotaGroups.forEach(group => {
                const remaining = Math.min(100, Math.max(0, group.remaining));
                const color = getRemainingColor(remaining);
                const style = getGroupStyle(group.id);
                const isSelected = group.id === selectedGroupId;

                const cardEl = document.createElement('div');
                cardEl.className = 'usage-card clickable' + (isSelected ? ' selected' : '');

                let iconContent = style.icon;
                if (style.image) {
                    iconContent = `<img src="${style.image}" class="model-icon-img" />`;
                }

                cardEl.innerHTML = `
                    <div class="usage-card-icon" style="background-color: ${style.bg}; color: ${style.iconColor}">${iconContent}</div>
                    <div class="usage-card-content">
                        <span class="usage-card-name">${group.name}</span>
                        <span class="usage-card-subtitle">${formatDate(group.resetDate)}</span>
                    </div>
                    <div class="usage-card-progress">
                        <div class="usage-bars" style="color: ${color}">
                            ${generateBars(remaining, color)}
                        </div>
                        <span class="usage-card-percent">${remaining}%</span>
                    </div>
                `;

                // Click to select and toggle details
                cardEl.addEventListener('click', () => {
                    if (selectedGroupId === group.id) {
                        selectedGroupId = null; // Toggle off
                    } else {
                        selectedGroupId = group.id; // Switch to this group
                    }
                    saveState();
                    renderUsage();
                });

                usageGroupsEl.appendChild(cardEl);

                // If selected, render details directly BELOW this card
                if (isSelected && group.models) {
                    const detailsContainer = document.createElement('div');
                    detailsContainer.className = 'usage-list visible';
                    detailsContainer.style.padding = '4px 8px 12px 10px'; // Align with the left edge of the card icon (card pad is 10px)

                    group.models.forEach(model => {
                        const modelRemaining = Math.min(100, Math.max(0, model.remaining));
                        const modelColor = getRemainingColor(modelRemaining);

                        const modelDiv = document.createElement('div');
                        modelDiv.className = 'model-item-compact';
                        modelDiv.innerHTML = `
                            <span class="usage-card-name" title="${model.name}">${model.name}</span>
                            <div class="usage-card-progress">
                                <div class="usage-bars" style="color: ${modelColor}">
                                    ${generateBars(modelRemaining, modelColor)}
                                </div>
                                <span class="usage-card-percent">${modelRemaining}%</span>
                            </div>
                        `;
                        detailsContainer.appendChild(modelDiv);
                    });
                    usageGroupsEl.appendChild(detailsContainer);
                }
            });
        }
    }

    // --- Context Menu Logic ---
    let ctxMenuTarget = null; // { id, path }
    const ctxMenuEl = document.createElement('div');
    ctxMenuEl.className = 'ctx-menu';
    ctxMenuEl.innerHTML = `

        <div class="ctx-item" id="ctx-separator" style="height:1px; background:var(--border-color); margin:4px 0; display:none;"></div>
        <div class="ctx-item" id="ctx-apply-skill" style="display:none;">
            <svg class="ctx-icon" viewBox="0 0 24 24"><path d="M4 17l6-6-6-6"></path><path d="M12 19h8"></path></svg>
            Apply Skill
        </div>
        <div class="ctx-item" id="ctx-delete-skill" style="display:none; color:var(--color-danger);">
            <svg class="ctx-icon" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete Skill
        </div>
        <div class="ctx-item" id="ctx-install-skill" style="display:none;">
            <svg class="ctx-icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            Install Skill
        </div>
        <div class="ctx-item" id="ctx-reveal">
            <svg class="ctx-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            Reveal in Finder
        </div>
    `;
    document.body.appendChild(ctxMenuEl);



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

    document.getElementById('ctx-install-skill').addEventListener('click', () => {
        if (ctxMenuTarget && ctxMenuTarget.path) {
            vscode.postMessage({ type: 'installSkill', path: ctxMenuTarget.path });
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
                const itemSeparator = document.getElementById('ctx-separator');
                const itemApply = document.getElementById('ctx-apply-skill');
                const itemDelete = document.getElementById('ctx-delete-skill');
                const itemInstall = document.getElementById('ctx-install-skill');
                const itemReveal = document.getElementById('ctx-reveal');

                // Reset all
                [itemSeparator, itemApply, itemDelete, itemInstall, itemReveal].forEach(el => {
                    if (el) el.style.display = 'none';
                });

                if (isNormalProject) {
                    itemReveal.style.display = 'flex';
                } else if (isGlobalHeader) {
                    itemInstall.style.display = 'flex';
                    itemReveal.style.display = 'flex';
                } else if (targetEl.classList.contains('folder-header') && targetEl.getAttribute('data-type') === 'skills') {
                    // Project Skills root
                    itemInstall.style.display = 'flex';
                    itemReveal.style.display = 'flex';
                } else if (isSkillRoot) {
                    // Specific Skill folder
                    itemApply.style.display = 'flex';
                    itemDelete.style.display = 'flex';
                    itemReveal.style.display = 'flex';
                } else {
                    // Files or subfolders
                    itemReveal.style.display = 'flex';
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
            // Check if we should use flat layout (single project mode)
            const useFlatLayout = projects.length === 1;

            if (useFlatLayout && projects.length > 0) {
                // FLAT LAYOUT MODE: Single project
                renderFlatLayout(projects[0]);
            } else {
                // NESTED LAYOUT MODE: Multiple projects or no projects
                renderNestedLayout();
            }
        } catch (e) {
            console.error('[UI] Error in renderProjects:', e);
        }
    }

    // Flat layout for single project
    function renderFlatLayout(project) {
        // Remove old nested layout elements
        const oldProjects = projectListEl.querySelectorAll('.project-item:not(.global-section)');
        oldProjects.forEach(el => el.remove());

        // 1. Render Global Skills
        renderGlobalSkillsSection();

        // 3. Render Project Skills (flat)
        renderFlatSection('skills', 'Project Skills', project);

        // 4. Render Chats (flat)
        renderFlatSection('chats', 'Chats', project);

        // 5. Render Files (flat)
        renderFlatSection('files', 'Files', project);
    }

    // Render a flat section (Skills/Chats/Files)
    function renderFlatSection(type, label, project) {
        const sectionId = `flat-${type}-${safeId(project.id)}`;
        const contentId = `content-${type}-${safeId(project.id)}`;

        let sectionEl = projectListEl.querySelector(`.flat-section[data-type="${type}"]`);

        if (!sectionEl) {
            sectionEl = document.createElement('div');
            sectionEl.className = 'flat-section section-card';
            sectionEl.setAttribute('data-type', type);

            // Icon Mapping
            const icons = {
                'skills': { icon: '🛠️', class: 'icon-project' },
                'chats': { icon: '💬', class: 'icon-chats' },
                'files': { icon: '📂', class: 'icon-files' }
            };
            const config = icons[type] || { icon: '📁', class: 'icon-project' };

            const header = document.createElement('div');
            header.className = 'folder-header';
            header.setAttribute('data-target', contentId);
            if (type === 'skills') {
                const skillsPath = (project.path || '').replace(/\/$/, '') + '/.agent/skills';
                header.setAttribute('data-path', skillsPath);
            } else if (type === 'files') {
                header.setAttribute('data-path', project.path);
            }
            header.setAttribute('data-type', type);

            const isExpanded = expandedFolders.has(contentId);

            header.innerHTML = `
                <div class="section-icon ${config.class}">${config.icon}</div>
                <span class="section-title">${label}</span>
                <span class="section-arrow ${isExpanded ? '' : 'collapsed'}">▼</span>
            `;

            const content = document.createElement('div');
            content.id = contentId;
            content.className = `folder-content ${isExpanded ? '' : 'collapsed'}`;

            sectionEl.appendChild(header);
            sectionEl.appendChild(content);
            projectListEl.appendChild(sectionEl);
        }

        // Update expansion state
        const isExpanded = expandedFolders.has(contentId);
        const arrow = sectionEl.querySelector('.section-arrow');
        const contentDiv = sectionEl.querySelector(`#${contentId}`);

        if (arrow) {
            arrow.className = 'section-arrow' + (isExpanded ? '' : ' collapsed');
        }
        if (contentDiv) {
            contentDiv.className = 'folder-content' + (isExpanded ? '' : ' collapsed');
        }

        // Update content based on type
        if (isExpanded && contentDiv) {
            if (type === 'skills') {
                const projectSkills = skills[project.id];
                if (projectSkills && projectSkills.length > 0) {
                    const newHtml = renderSkills(projectSkills, project.id, 0);
                    if (contentDiv.innerHTML !== newHtml) {
                        contentDiv.innerHTML = newHtml;
                        bindFileClickEvents(contentDiv);
                    }
                } else {
                    contentDiv.innerHTML = '<div class="folder-empty">No skills found</div>';
                }
            } else if (type === 'chats') {
                renderChatsInner(contentDiv, project, allConversations);
            } else if (type === 'files') {
                const filesData = projectFiles[project.id];
                if (filesData && filesData.length > 0) {
                    const newHtml = renderSkills(filesData, project.id, 0);
                    if (contentDiv.innerHTML !== newHtml) {
                        contentDiv.innerHTML = newHtml;
                        bindFileClickEvents(contentDiv);
                    }
                } else if (!filesData) {
                    vscode.postMessage({ type: 'requestFiles', projectId: project.id, path: project.path });
                    contentDiv.innerHTML = '<div class="folder-empty">Loading project files...</div>';
                } else {
                    contentDiv.innerHTML = '<div class="folder-empty">No files found</div>';
                }
            }
        }
    }

    // Helper to bind file click events
    function bindFileClickEvents(container) {
        container.querySelectorAll('.file-item').forEach(el => {
            el.onclick = (e) => {
                e.stopPropagation();
                const filePath = el.getAttribute('data-path');
                if (filePath) {
                    vscode.postMessage({ type: 'openFile', path: filePath });
                }
            };
        });
    }

    function renderGlobalSkillsSection() {
        let globalEl = projectListEl.querySelector('.global-section');
        if (globalSkills) {
            if (!globalEl) {
                globalEl = document.createElement('div');
                globalEl.className = 'flat-section section-card global-section';
                globalEl.style.marginBottom = '8px';
                projectListEl.prepend(globalEl);
            }

            globalEl.innerHTML = '';

            const header = document.createElement('div');
            header.className = 'folder-header';
            header.dataset.target = 'global-skills-content';
            if (globalSkillsPath) header.dataset.path = globalSkillsPath;
            header.style.cursor = 'pointer';

            const isExpanded = expandedFolders.has('global-skills-content');

            header.innerHTML = `
                <div class="section-icon icon-global">🌍</div>
                <span class="section-title">Global Skills</span>
                <span class="section-arrow ${isExpanded ? '' : 'collapsed'}">▼</span>
            `;

            const content = document.createElement('div');
            content.id = 'global-skills-content';
            content.className = `folder-content ${isExpanded ? '' : 'collapsed'}`;

            const hasSkills = globalSkills.length > 0;
            if (hasSkills) {
                content.innerHTML = renderSkills(globalSkills, 'global', 0);
                content.querySelectorAll('.file-item').forEach(el => {
                    el.onclick = (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'openFile', path: el.dataset.path });
                    };
                });
            } else {
                content.innerHTML = '<div class="folder-empty">No global skills found</div>';
            }

            globalEl.appendChild(header);
            globalEl.appendChild(content);
        } else if (globalEl) {
            globalEl.remove();
        }
    }

    // Nested layout for multiple projects
    function renderNestedLayout() {
        // Clear any flat layout elements
        projectListEl.innerHTML = ''; // Clear everything for a fresh render of nested layout

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
        // 排序逻辑：先按拼音排序，活跃项目置顶
        const sortedProjects = [...projects].sort((a, b) => {
            // 先按拼音排序
            return a.name.localeCompare(b.name, 'zh-Hans', { sensitivity: 'base' });
        });

        // 将活跃项目移到第一位
        if (activeProjectPath) {
            const normActive = activeProjectPath.toLowerCase();
            const activeIndex = sortedProjects.findIndex(p => {
                const normProject = p.path.toLowerCase();
                return normActive === normProject ||
                    normActive.startsWith(normProject + '/') ||
                    normActive.startsWith(normProject + '\\');
            });
            if (activeIndex > 0) {
                const [activeProject] = sortedProjects.splice(activeIndex, 1);
                sortedProjects.unshift(activeProject);
            }
        }

        sortedProjects.forEach((project, index) => {
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
        const chatContentId = `content-chats-${safeId(project.id)}`;
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
        const skillsContentId = `content-skills-${safeId(project.id)}`;
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
                <div class="folder-header" data-target="${skillsContentId}" data-path="${skillsPath}" data-type="skills">
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

        // --- Files Folder ---
        const filesContentId = `content-files-${safeId(project.id)}`;
        let filesContainer = contentEl.querySelector(`.folder-container[data-type="files"]`);

        if (!filesContainer) {
            filesContainer = document.createElement('div');
            filesContainer.className = 'folder-container';
            filesContainer.setAttribute('data-type', 'files');
            filesContainer.innerHTML = `
                <div class="folder-header" data-target="${filesContentId}" data-path="${project.path}" data-type="files">
                    <span class="folder-arrow">▼</span>
                    <span>Files</span>
                </div>
                <div id="${filesContentId}" class="folder-content"></div>
            `;
            contentEl.appendChild(filesContainer);
        }

        // Update Files State
        const isFilesExpanded = expandedFolders.has(filesContentId);
        const filesArrow = filesContainer.querySelector('.folder-arrow');
        const filesContentDiv = filesContainer.querySelector(`#${filesContentId}`);

        filesArrow.className = 'folder-arrow' + (isFilesExpanded ? '' : ' collapsed');
        filesContentDiv.className = 'folder-content' + (isFilesExpanded ? '' : ' collapsed');

        // Update Files Content
        if (isFilesExpanded) {
            const filesData = projectFiles[project.id];
            if (filesData && filesData.length > 0) {
                const newFilesHtml = renderSkills(filesData, project.id, 0); // Reuse tree renderer
                if (filesContentDiv.innerHTML !== newFilesHtml) {
                    filesContentDiv.innerHTML = newFilesHtml;
                    // Re-bind click events for files
                    filesContentDiv.querySelectorAll('.file-item').forEach(el => {
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
                // Trigger fetch if empty and expanded
                if (!filesData) {
                    vscode.postMessage({ type: 'requestFiles', projectId: project.id, path: project.path });
                    filesContentDiv.innerHTML = '<div class="folder-empty">Loading project files...</div>';
                } else {
                    filesContentDiv.innerHTML = '<div class="folder-empty">No files found</div>';
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
            // Handle file:// protocol, normalize slashes
            let decoded = p;
            try {
                decoded = decodeURIComponent(p.replace(/^file:\/\/\/?/, ''));
            } catch (e) { }

            return decoded
                .replace(/\\/g, '/')
                .replace(/\/$/, '')
                .toLowerCase();
        }

        const projectPathNorm = normalizePath(project.path);

        // Debug first project to reduce noise, or specific projects
        const shouldLog = projects.indexOf(project) === 0 || project.path.includes('Ares') || project.path.includes('Projects');
        if (shouldLog) {
            console.log(`[UI][Match] Project: ${project.path} (Norm: ${projectPathNorm})`);
        }

        // 严格路径匹配：只显示精确属于此项目的 chats
        // 规则：chat 的 workspacePath 必须等于或在项目路径内
        let projectConvos = allConvos.filter(c => {
            if (!c.workspacePath) {
                if (shouldLog) console.log(`   [SKIP] ${c.title}: No workspacePath`);
                return false;
            }
            const convoPathNorm = normalizePath(c.workspacePath);
            // 精确匹配或 chat 在项目目录内
            let isMatch = convoPathNorm === projectPathNorm || convoPathNorm.startsWith(projectPathNorm + '/');

            // Soft match fallback removed to ensure strict attribution.
            // Previous logic allowed "ProjectA" to match "ProjectA_Backup" which is undesirable.

            return isMatch;
            // 注意：移除了 projectPathNorm.startsWith(convoPathNorm + '/')
            // 这个条件会导致父目录的 chats 也显示在子目录项目中
        });

        // 严格路径匹配：不再添加孤儿对话
        // 每个项目只显示 workspacePath 精确匹配或在项目目录内的对话

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
                <div class="conversation-item sub-item" data-id="${convo.id}" data-workspace-path="${convo.workspacePath || ''}">
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
                const chatPath = item.getAttribute('data-workspace-path');
                vscode.postMessage({
                    type: 'handleChatClick',
                    cascadeId: cid,
                    // Pass the ACTUAL path of the chat, not the project's own path.
                    // This allows VS Code to correctly detect if it's across projects.
                    projectPath: chatPath || undefined
                });
            };
        });
    }

    function toggleFolderExpansion(folderId) {
        if (expandedFolders.has(folderId)) {
            expandedFolders.delete(folderId);
        } else {
            expandedFolders.add(folderId);
        }
        saveState();
        renderProjects();
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
                if (targetId) {
                    toggleFolderExpansion(targetId);
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
