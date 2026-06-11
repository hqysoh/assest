const ProjectModule = {
    currentProjectId: null,
    currentTab: 'script',

    render(projectId) {
        this.currentProjectId = projectId;
        const project = Storage.getProject(projectId);

        if (!project) {
            App.navigateToHome();
            return;
        }

        if (!project.props) project.props = [];
        if (!project.scenes) project.scenes = [];

        const mainContent = document.getElementById('mainContent');
        mainContent.innerHTML = `
            <div class="page-header">
                <div class="page-title-row">
                    <h1 class="page-title" id="projectTitle">${this.escapeHtml(project.displayName || project.name)}</h1>
                    <button class="btn-rename-title" onclick="ProjectModule.showRenameModal()" title="重命名">✏️</button>
                </div>
                <p class="project-original-hint">原始名称: ${this.escapeHtml(project.name)}</p>
            </div>
            <div class="nav-tabs">
                <button class="nav-tab ${this.currentTab === 'script' ? 'active' : ''}" onclick="ProjectModule.switchTab('script')">📜 剧本</button>
                <button class="nav-tab ${this.currentTab === 'characters' ? 'active' : ''}" onclick="ProjectModule.switchTab('characters')">👥 人物</button>
                <button class="nav-tab ${this.currentTab === 'props' ? 'active' : ''}" onclick="ProjectModule.switchTab('props')">🔧 道具</button>
                <button class="nav-tab ${this.currentTab === 'scenes' ? 'active' : ''}" onclick="ProjectModule.switchTab('scenes')">🏞️ 场景</button>
                <button class="nav-tab ${this.currentTab === 'storyboard' ? 'active' : ''}" onclick="ProjectModule.switchTab('storyboard')">🎬 分镜</button>
                <button class="nav-tab ${this.currentTab === 'videos' ? 'active' : ''}" onclick="ProjectModule.switchTab('videos')">🎞️ 视频历史</button>
            </div>
            <div id="tabContent" class="content-section"></div>
        `;

        this.renderTabContent();
    },

    switchTab(tab) {
        this.currentTab = tab;
        this.render(this.currentProjectId);
    },

    renderTabContent() {
        switch (this.currentTab) {
            case 'script':
                ScriptModule.render(this.currentProjectId);
                break;
            case 'characters':
                CharacterModule.render(this.currentProjectId);
                break;
            case 'props':
                PropsScenesModule.render(this.currentProjectId, 'props');
                break;
            case 'scenes':
                PropsScenesModule.render(this.currentProjectId, 'scenes');
                break;
            case 'storyboard':
                StoryboardModule.render(this.currentProjectId);
                break;
            case 'videos':
                StoryboardModule.renderVideoHistory(this.currentProjectId);
                break;
        }
    },

    renderPlaceholder(title, icon, message) {
        const tabContent = document.getElementById('tabContent');
        tabContent.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">${icon}</div>
                <div class="empty-state-text">${message}</div>
            </div>
        `;
    },

    showRenameModal() {
        const project = Storage.getProject(this.currentProjectId);
        if (!project) return;
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
                <button class="btn-primary" onclick="ProjectModule.renameProject()">保存</button>
            </div>
        `;
        document.getElementById('modalOverlay').classList.add('active');
        document.getElementById('renameInput').focus();
    },

    renameProject() {
        const newName = document.getElementById('renameInput').value.trim();
        if (!newName) { App.showToast('请输入名称', 'error'); return; }
        Storage.updateProject(this.currentProjectId, { displayName: newName });
        App.closeModal();
        App.showToast('项目已重命名', 'success');
        this.render(this.currentProjectId);
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
