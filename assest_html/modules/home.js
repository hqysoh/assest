const HomeModule = {
    render() {
        const projects = Storage.getProjects();
        const mainContent = document.getElementById('mainContent');

        mainContent.innerHTML = `
            <div class="page-header">
                <h1 class="page-title">资产库</h1>
                <p class="page-subtitle">管理您的创作项目</p>
            </div>
            <div class="projects-grid">
                ${projects.map(project => this.renderProjectCard(project)).join('')}
                <div class="add-project-card" onclick="HomeModule.showCreateProjectModal()">
                    <span class="add-project-icon">+</span>
                    <span>创建新项目</span>
                </div>
            </div>
        `;
    },

    renderProjectCard(project) {
        const date = new Date(project.createdAt).toLocaleDateString('zh-CN');
        const displayName = project.displayName || project.name;
        const showHint = project.displayName && project.displayName !== project.name;
        return `
            <div class="project-card" onclick="App.navigateToProject('${project.id}')">
                <div class="project-card-actions">
                    <button class="btn-icon" onclick="event.stopPropagation(); HomeModule.showRenameModal('${project.id}')" title="重命名">✏️</button>
                    <button class="btn-icon" onclick="event.stopPropagation(); HomeModule.deleteProject('${project.id}')" title="删除">🗑️</button>
                </div>
                <div class="project-card-icon">📁</div>
                <div class="project-card-title">${this.escapeHtml(displayName)}</div>
                ${showHint ? `<div class="project-card-original">原始名称: ${this.escapeHtml(project.name)}</div>` : ''}
                <div class="project-card-date"><span>🗓️</span><span>创建于 ${date}</span></div>
            </div>
        `;
    },

    showRenameModal(id) {
        const project = Storage.getProject(id);
        const current = project.displayName || project.name;
        const modalContent = document.getElementById('modalContent');
        modalContent.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">重命名项目</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">显示名称</label>
                    <input type="text" class="form-input" id="renameInput" value="${this.escapeHtml(current)}">
                </div>
                <p style="color:var(--t3); font-size:0.82rem;">原始名称: ${this.escapeHtml(project.name)} (此名称不变，文件夹不受影响)</p>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" onclick="HomeModule.renameProject('${id}')">保存</button>
            </div>
        `;
        document.getElementById('modalOverlay').classList.add('active');
        document.getElementById('renameInput').focus();
    },

    renameProject(id) {
        const newName = document.getElementById('renameInput').value.trim();
        if (!newName) { App.showToast('请输入名称', 'error'); return; }
        Storage.updateProject(id, { displayName: newName });
        App.closeModal();
        App.showToast('项目已重命名', 'success');
        this.render();
    },

    showCreateProjectModal() {
        const modalContent = document.getElementById('modalContent');
        modalContent.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">创建新项目</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">项目名称</label>
                    <input type="text" class="form-input" id="projectNameInput" placeholder="输入项目名称">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" onclick="HomeModule.createProject()">创建</button>
            </div>
        `;
        document.getElementById('modalOverlay').classList.add('active');
        document.getElementById('projectNameInput').focus();
    },

    createProject() {
        const name = document.getElementById('projectNameInput').value.trim();
        if (!name) { App.showToast('请输入项目名称', 'error'); return; }
        const project = Storage.createProject(name);
        App.closeModal();
        App.showToast('项目创建成功', 'success');
        App.navigateToProject(project.id);
    },

    async deleteProject(id) {
        const ok = await App.confirm({
            title: '🗑️ 删除项目',
            message: '确定要删除这个项目吗？此操作不可撤销。',
            okText: '删除',
            cancelText: '取消',
            danger: true,
        });
        if (!ok) return;
        Storage.deleteProject(id);
        App.showToast('项目已删除', 'success');
        this.render();
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
