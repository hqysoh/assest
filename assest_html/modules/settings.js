const SettingsModule = {
    render() {
        const s = Storage.getSettings();
        const main = document.getElementById('mainContent');
        const groups = s.imageApiGroups || [];
        const defs = s.imageDefaults || {};
        const voice = s.voiceSettings || {};
        const theme = s.theme || 'dark';
        const gHtml = groups.map(g => this.renderGroup(g)).join('');

        main.innerHTML = `
        <div class="page-header">
            <div class="page-title-row">
                <h1 class="page-title">设置</h1>
                <div class="settings-header-right">
                    <span class="autosave-indicator" id="savedFlag"><span class="autosave-dot"></span>已自动保存</span>
                    <button class="btn-ghost btn-tiny btn-ghost-danger" onclick="SettingsModule.resetDefaults()" title="将所有设置恢复为默认值">↺ 恢复默认</button>
                </div>
            </div>
            <p class="page-subtitle">配置外观、AI 接口、图像生成与全局提示词 · <strong>所有修改即时自动保存到数据库</strong></p>
        </div>

        <div class="settings-section">
            <h2 class="settings-section-title">🎨 外观主题</h2>
            <div class="setting-row">
                <div class="setting-row-info">
                    <span class="setting-row-title">界面主题</span>
                    <span class="setting-row-desc">选择浅色或深色外观，立即生效并持久保存</span>
                </div>
                <div class="theme-options">
                    <div class="theme-chip ${theme==='dark'?'active':''}" onclick="SettingsModule.setTheme('dark')"><span>🌙</span><span>深色</span></div>
                    <div class="theme-chip ${theme==='light'?'active':''}" onclick="SettingsModule.setTheme('light')"><span>☀️</span><span>浅色</span></div>
                </div>
            </div>
        </div>

        <div class="settings-section">
            <h2 class="settings-section-title">🧠 Claude / LLM 接口</h2>
            <div class="form-row">
                <div class="form-col">
                    <label class="form-label">API 地址</label>
                    <input class="form-input" id="llmApiUrl" value="${this.esc(s.llmApiUrl)}" placeholder="https://api.anthropic.com 或留空使用本地 Claude Code"
                        onchange="SettingsModule.autoSave('llmApiUrl', this.value)">
                </div>
                <div class="form-col">
                    <label class="form-label">API Key</label>
                    <input class="form-input" id="llmApiKey" type="password" value="${this.esc(s.llmApiKey)}" placeholder="sk-ant-..."
                        onchange="SettingsModule.autoSave('llmApiKey', this.value)">
                </div>
            </div>
            <p class="form-hint">用于剧本提取（人物 / 道具 / 场景）。留空则使用后端默认的本地 Claude Code。</p>
        </div>

        <div class="settings-section">
            <h2 class="settings-section-title">🖼️ 图像生成 API 分组</h2>
            <div id="apiGroupsContainer">${gHtml || '<p class="form-hint">暂无分组，点击下方按钮添加。</p>'}</div>
            <button class="btn-secondary btn-small" onclick="SettingsModule.addGroup()" style="margin-top:0.8rem">＋ 添加分组</button>
        </div>

        <div class="settings-section">
            <h2 class="settings-section-title">⚙️ 图像生成全局默认</h2>
            <div class="form-row">
                <div class="form-col"><label class="form-label">画质</label><select class="form-input" id="imgQuality" onchange="SettingsModule.saveImageDefaults()">${this.opts(['auto','low','medium','high'],defs.quality||'auto')}</select></div>
                <div class="form-col"><label class="form-label">默认尺寸</label><select class="form-input" id="imgSize" onchange="SettingsModule.saveImageDefaults()">${this.sizeLabelOpts(defs.size||'auto')}</select></div>
            </div>
        </div>

        <div class="settings-section">
            <h2 class="settings-section-title">🔊 语音生成</h2>
            <div class="form-group">
                <label class="form-label">默认朗读文本模板</label>
                <input class="form-input" id="voiceTemplate" value="${this.esc(voice.textTemplate || '我是{name}，这是我的音色，很高兴认识你')}" placeholder="我是{name}，这是我的音色"
                    onchange="SettingsModule.autoSaveVoice(this.value)">
                <p class="form-hint">使用 <code>{name}</code> 作为人物姓名占位符。生成音频弹窗会以此为默认文本。</p>
            </div>
        </div>

        <div class="settings-section">
            <div class="section-title-row">
                <h2 class="settings-section-title">📝 全局提示词</h2>
                <div class="section-title-actions">
                    <button class="btn-ghost btn-tiny" id="promptCollapseBtn" onclick="SettingsModule.togglePromptCollapse()" title="收起 / 展开">${this._promptCollapsed ? '▾ 展开' : '▴ 收起'}</button>
                    <button class="btn-ghost btn-tiny" onclick="SettingsModule.expandPrompt()" title="全屏编辑">⛶ 全屏编辑</button>
                    <button class="btn-ghost btn-tiny" onclick="SettingsModule.resetPrompt()" title="重置为推荐提示词">✨ 重置推荐</button>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">人物 / 道具 / 场景 提取提示词</label>
                <textarea class="form-textarea prompt-editor ${this._promptCollapsed ? 'collapsed' : ''}" id="globalPrompt"
                    oninput="SettingsModule.autoGrow(this)"
                    onchange="SettingsModule.autoSave('globalPrompt', this.value)">${this.esc(s.globalPrompt)}</textarea>
                <div class="prompt-editor-foot">
                    <p class="form-hint" style="margin:0">提取剧本素材时发送给 LLM 的指令。可在剧本页临时修改，此处为默认值。</p>
                    <span class="char-counter" id="promptCounter">0 字</span>
                </div>
            </div>
        </div>

        <div class="settings-section">
            <div class="section-title-row">
                <h2 class="settings-section-title">🎬 分镜提取提示词</h2>
                <div class="section-title-actions">
                    <button class="btn-ghost btn-tiny" id="sbPromptCollapseBtn" onclick="SettingsModule.toggleSbPromptCollapse()" title="收起 / 展开">${this._sbPromptCollapsed ? '▾ 展开' : '▴ 收起'}</button>
                    <button class="btn-ghost btn-tiny" onclick="SettingsModule.expandSbPrompt()" title="全屏编辑">⛶ 全屏编辑</button>
                    <button class="btn-ghost btn-tiny" onclick="SettingsModule.resetSbPrompt()" title="重置为推荐提示词">✨ 重置推荐</button>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">LTX 2.3 分镜导演提示词（四宫格 / local / global / 台词人物映射）</label>
                <textarea class="form-textarea prompt-editor ${this._sbPromptCollapsed ? 'collapsed' : ''}" id="storyboardPrompt"
                    oninput="SettingsModule.autoGrowSb(this)"
                    onchange="SettingsModule.autoSave('storyboardPrompt', this.value)">${this.esc(s.storyboardPrompt)}</textarea>
                <div class="prompt-editor-foot">
                    <p class="form-hint" style="margin:0">在分镜页传入剧本 + 已有人物/道具/场景，调用 Claude Code 生成分镜 JSON 时使用。</p>
                    <span class="char-counter" id="sbPromptCounter">0 字</span>
                </div>
            </div>
        </div>`;

        // After render: size the prompt editor and update counter
        requestAnimationFrame(() => {
            const ta = document.getElementById('globalPrompt');
            if (ta) { this.autoGrow(ta); this.updateCounter(ta); }
            const sb = document.getElementById('storyboardPrompt');
            if (sb) { this.autoGrowSb(sb); }
        });
    },

    renderGroup(g) {
        const keyMasked = g.apiKey ? g.apiKey.slice(0,8) + '...' + g.apiKey.slice(-4) : '未设置';
        const defs = Storage.getSettings().imageDefaults || {};
        const isDefault = defs.activeGroupId === g.id;
        return `<div class="api-group-card" data-gid="${g.id}">
            <div class="api-group-header">
                <div class="api-group-badge ${isDefault ? 'badge-default' : ''}">
                    <span class="api-group-badge-name" ondblclick="SettingsModule.editBadgeName(this,'${g.id}')" title="双击重命名">${this.esc(g.name)}</span>
                    ${isDefault ? '<span class="badge-star">⭐</span>' : ''}
                </div>
                <div class="api-group-header-btns">
                    ${!isDefault ? `<button class="btn-ghost btn-tiny" onclick="SettingsModule.setDefaultGroup('${g.id}')">⭐ 设为默认</button>` : '<span class="badge-default-label">默认分组</span>'}
                    <button class="btn-ghost btn-ghost-danger btn-tiny" onclick="SettingsModule.removeGroup('${g.id}')">🗑️</button>
                </div>
            </div>
            <div class="form-row">
                <div class="form-col"><label class="form-label-sm">API 地址</label><input class="form-input" value="${this.esc(g.url)}" placeholder="https://token.ithinkai.cn/v1" onchange="SettingsModule.updateGroupField('${g.id}','url',this.value)"></div>
                <div class="form-col"><label class="form-label-sm">API Key</label><input class="form-input" type="password" value="${this.esc(g.apiKey)}" placeholder="sk-..." onchange="SettingsModule.updateGroupField('${g.id}','apiKey',this.value)"><span class="form-hint">当前: ${this.esc(keyMasked)}</span></div>
            </div>
            <label class="form-label-sm">模型列表（逗号分隔）</label>
            <input class="form-input" value="${this.esc((g.models||[]).join(', '))}" placeholder="dall-e-3, gpt-image-2" onchange="SettingsModule.updateGroupField('${g.id}','models',this.value.split(',').map(m=>m.trim()).filter(m=>m))">
        </div>`;
    },

    // ====== 自动保存（字段级，立即持久化到 localStorage + 后端） ======
    autoSave(field, value) {
        const v = typeof value === 'string' ? value.trim() : value;
        Storage.saveSettings({ [field]: v });
        this.flashSaved();
    },

    autoSaveVoice(template) {
        const s = Storage.getSettings();
        const voiceSettings = { ...(s.voiceSettings || {}), textTemplate: template.trim() || '我是{name}，这是我的音色，很高兴认识你' };
        Storage.saveSettings({ voiceSettings });
        this.flashSaved();
    },

    saveImageDefaults() {
        const s = Storage.getSettings();
        const defs = {
            ...(s.imageDefaults || {}),
            quality: document.getElementById('imgQuality').value,
            size: document.getElementById('imgSize').value
        };
        Storage.saveSettings({ imageDefaults: defs });
        this.flashSaved();
    },

    setTheme(theme) {
        Storage.saveSettings({ theme });
        App.applyTheme();
        this.flashSaved();
        this.render();
    },

    flashSaved() {
        const flag = document.getElementById('savedFlag');
        if (!flag) return;
        flag.classList.add('saving');
        flag.innerHTML = '<span class="autosave-dot"></span>已保存到数据库';
        clearTimeout(this._flagTimer);
        this._flagTimer = setTimeout(() => {
            flag.classList.remove('saving');
            flag.innerHTML = '<span class="autosave-dot"></span>已自动保存';
        }, 1800);
    },

    addGroup() {
        const s = Storage.getSettings();
        if (!s.imageApiGroups) s.imageApiGroups = [];
        s.imageApiGroups.push({ id: Date.now().toString(), name: '新分组', url: 'https://token.ithinkai.cn/v1', apiKey: '', models: ['dall-e-3'] });
        Storage.saveSettings({ imageApiGroups: s.imageApiGroups });
        this.render();
        App.showToast('已添加分组', 'success');
    },

    setDefaultGroup(gid) {
        const s = Storage.getSettings();
        s.imageDefaults = s.imageDefaults || {};
        s.imageDefaults.activeGroupId = gid;
        Storage.saveSettings({ imageDefaults: s.imageDefaults });
        this.render();
        App.showToast('已设为默认分组', 'success');
    },

    removeGroup(gid) {
        if (!window.confirm('确定删除此分组？此操作无法撤销。')) return;
        const s = Storage.getSettings();
        const groups = s.imageApiGroups || [];
        const filtered = groups.filter(g => String(g.id) !== String(gid));
        if (filtered.length === groups.length) { App.showToast('未找到该分组', 'error'); return; }
        s.imageApiGroups = filtered;
        if (s.imageDefaults && s.imageDefaults.activeGroupId === gid && filtered.length > 0) {
            s.imageDefaults.activeGroupId = filtered[0].id;
        }
        Storage.saveSettings({ imageApiGroups: s.imageApiGroups, imageDefaults: s.imageDefaults });
        App.showToast('分组已删除', 'success');
        this.render();
    },

    updateGroupField(gid, field, value) {
        const s = Storage.getSettings();
        const group = (s.imageApiGroups || []).find(g => g.id === gid);
        if (group) { group[field] = value; Storage.saveSettings({ imageApiGroups: s.imageApiGroups }); this.flashSaved(); }
    },

    editBadgeName(span, gid) {
        const cur = span.textContent;
        const inp = document.createElement('input');
        inp.className = 'badge-edit-input';
        inp.value = cur;
        inp.onblur = () => { this.updateGroupField(gid, 'name', inp.value.trim() || '未命名'); this.render(); };
        inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
        span.replaceWith(inp);
        inp.focus(); inp.select();
    },

    resetDefaults() {
        if (!window.confirm('确定恢复所有设置为默认值？API Key 等配置将被重置。')) return;
        const def = Storage.getDefaultSettings();
        Storage.saveSettings(def);
        App.applyTheme();
        this.render();
        App.showToast('已恢复默认设置', 'success');
    },

    // 只重置提取提示词为推荐版本，不影响 API Key 等其它配置
    resetPrompt() {
        if (!window.confirm('确定将提示词重置为系统推荐版本？当前内容会被覆盖（不影响 API Key 等其它配置）。')) return;
        const def = Storage.getDefaultSettings();
        const ta = document.getElementById('globalPrompt');
        if (ta) { ta.value = def.globalPrompt; this.autoGrow(ta); this.updateCounter(ta); }
        Storage.saveSettings({ globalPrompt: def.globalPrompt });
        this.flashSaved();
        App.showToast('✨ 已重置为推荐提示词', 'success');
    },

    // ====== 长文本编辑辅助 ======
    // 折叠状态默认值（首次进入设置页折叠，保持页面整洁）
    _promptCollapsed: true,

    autoGrow(ta) {
        if (!ta) return;
        this.updateCounter(ta);
        // 折叠状态由 CSS 固定高度 + 滚动，不自动增高
        if (ta.classList.contains('collapsed')) { ta.style.height = ''; return; }
        ta.style.height = 'auto';
        ta.style.height = Math.min(Math.max(ta.scrollHeight, 160), 640) + 'px';
    },

    // 收起 / 展开 提示词编辑器
    togglePromptCollapse() {
        this._promptCollapsed = !this._promptCollapsed;
        const ta = document.getElementById('globalPrompt');
        const btn = document.getElementById('promptCollapseBtn');
        if (ta) {
            ta.classList.toggle('collapsed', this._promptCollapsed);
            this.autoGrow(ta);
            if (!this._promptCollapsed) ta.focus();
        }
        if (btn) btn.textContent = this._promptCollapsed ? '▾ 展开' : '▴ 收起';
    },

    updateCounter(ta) {
        const c = document.getElementById('promptCounter');
        if (c && ta) c.textContent = `${(ta.value || '').length} 字`;
    },

    // 全屏编辑提示词：在模态框中提供大编辑区，关闭时回写
    expandPrompt() {
        const cur = (document.getElementById('globalPrompt') || {}).value || '';
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">📝 全屏编辑提示词</h2><button class="modal-close" onclick="SettingsModule.closePromptModal()">×</button></div>
            <div class="modal-body">
                <textarea class="form-textarea prompt-editor prompt-editor-full" id="globalPromptFull">${this.esc(cur)}</textarea>
                <div class="prompt-editor-foot"><span class="form-hint">编辑后点击「应用」保存</span><span class="char-counter" id="promptCounterFull">${cur.length} 字</span></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="SettingsModule.closePromptModal()">取消</button>
                <button class="btn-primary" onclick="SettingsModule.applyPromptFromModal()">✓ 应用</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
        const full = document.getElementById('globalPromptFull');
        full.addEventListener('input', () => {
            const c = document.getElementById('promptCounterFull');
            if (c) c.textContent = `${full.value.length} 字`;
        });
        full.focus();
    },

    applyPromptFromModal() {
        const full = document.getElementById('globalPromptFull');
        if (!full) return;
        const val = full.value;
        const ta = document.getElementById('globalPrompt');
        if (ta) { ta.value = val; this.autoGrow(ta); }
        Storage.saveSettings({ globalPrompt: val.trim() });
        this.flashSaved();
        App.closeModal();
        App.showToast('✅ 提示词已更新', 'success');
    },

    closePromptModal() { App.closeModal(); },

    // ====== 分镜提示词（storyboardPrompt）专用辅助 ======
    _sbPromptCollapsed: true,

    autoGrowSb(ta) {
        if (!ta) return;
        const c = document.getElementById('sbPromptCounter');
        if (c) c.textContent = `${(ta.value || '').length} 字`;
        if (ta.classList.contains('collapsed')) { ta.style.height = ''; return; }
        ta.style.height = 'auto';
        ta.style.height = Math.min(Math.max(ta.scrollHeight, 160), 640) + 'px';
    },

    toggleSbPromptCollapse() {
        this._sbPromptCollapsed = !this._sbPromptCollapsed;
        const ta = document.getElementById('storyboardPrompt');
        const btn = document.getElementById('sbPromptCollapseBtn');
        if (ta) {
            ta.classList.toggle('collapsed', this._sbPromptCollapsed);
            this.autoGrowSb(ta);
            if (!this._sbPromptCollapsed) ta.focus();
        }
        if (btn) btn.textContent = this._sbPromptCollapsed ? '▾ 展开' : '▴ 收起';
    },

    resetSbPrompt() {
        if (!window.confirm('确定将分镜提示词重置为系统推荐版本？当前内容会被覆盖。')) return;
        const def = Storage.getDefaultSettings();
        const ta = document.getElementById('storyboardPrompt');
        if (ta) { ta.value = def.storyboardPrompt; this.autoGrowSb(ta); }
        Storage.saveSettings({ storyboardPrompt: def.storyboardPrompt });
        this.flashSaved();
        App.showToast('✨ 已重置为推荐分镜提示词', 'success');
    },

    expandSbPrompt() {
        const cur = (document.getElementById('storyboardPrompt') || {}).value || '';
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🎬 全屏编辑分镜提示词</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                <textarea class="form-textarea prompt-editor prompt-editor-full" id="storyboardPromptFull">${this.esc(cur)}</textarea>
                <div class="prompt-editor-foot"><span class="form-hint">编辑后点击「应用」保存</span><span class="char-counter" id="sbPromptCounterFull">${cur.length} 字</span></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" onclick="SettingsModule.applySbPromptFromModal()">✓ 应用</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
        const full = document.getElementById('storyboardPromptFull');
        full.addEventListener('input', () => {
            const c = document.getElementById('sbPromptCounterFull');
            if (c) c.textContent = `${full.value.length} 字`;
        });
        full.focus();
    },

    applySbPromptFromModal() {
        const full = document.getElementById('storyboardPromptFull');
        if (!full) return;
        const val = full.value;
        const ta = document.getElementById('storyboardPrompt');
        if (ta) { ta.value = val; this.autoGrowSb(ta); }
        Storage.saveSettings({ storyboardPrompt: val.trim() });
        this.flashSaved();
        App.closeModal();
        App.showToast('✅ 分镜提示词已更新', 'success');
    },

    opts(arr, sel) { return arr.map(v => `<option value="${v}" ${v===sel?'selected':''}>${v}</option>`).join(''); },
    sizeLabelOpts(sel) {
        const sizes = [
            {v:'auto',l:'auto 默认'},
            {v:'1024x1024',l:'1024x1024 正方形 1:1'},
            {v:'1536x1024',l:'1536x1024 横屏 3:2'},
            {v:'1024x1536',l:'1024x1536 竖屏 2:3'},
            {v:'2048x2048',l:'2048x2048 2K正方形 1:1'},
            {v:'2048x1152',l:'2048x1152 2K横屏 16:9'},
            {v:'3840x2160',l:'3840x2160 4K横屏 16:9'},
            {v:'2160x3840',l:'2160x3840 4K竖屏 9:16'}
        ];
        return sizes.map(s => `<option value="${s.v}" ${s.v===sel?'selected':''}>${s.l}</option>`).join('');
    },
    esc(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }
};
