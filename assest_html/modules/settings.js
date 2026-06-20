const SettingsModule = {
    // 打开设置弹窗（独立 overlay，不影响当前浏览的页面）。关闭时直接隐藏即可恢复。
    open() {
        this.render();
    },
    // 关闭设置弹窗：仅隐藏弹窗，不触碰主内容（当前页面保持不变）。
    close() {
        const ov = document.getElementById('settingsOverlay');
        if (ov) ov.classList.remove('active');
    },

    // 确保设置弹窗的 overlay/容器存在（独立于通用 modalOverlay，
    // 这样设置内部的「全屏编辑提示词」子弹窗仍可叠加在其之上）。
    _ensureOverlay() {
        let ov = document.getElementById('settingsOverlay');
        if (!ov) {
            ov = document.createElement('div');
            ov.id = 'settingsOverlay';
            ov.className = 'modal-overlay';
            ov.innerHTML = '<div class="modal settings-modal" id="settingsModal"></div>';
            document.body.appendChild(ov);
            // 点击遮罩空白处关闭
            ov.addEventListener('click', (e) => { if (e.target === ov) this.close(); });
        }
        return ov;
    },

    render() {
        const s = Storage.getSettings();
        const ov = this._ensureOverlay();
        const box = ov.querySelector('#settingsModal');
        const groups = s.imageApiGroups || [];
        const defs = s.imageDefaults || {};
        const voice = s.voiceSettings || {};
        const theme = s.theme || 'dark';
        const gHtml = groups.map(g => this.renderGroup(g)).join('');

        box.innerHTML = `
        <div class="modal-header">
            <h2 class="modal-title">设置</h2>
            <div class="settings-header-right">
                <span class="autosave-indicator" id="savedFlag"><span class="autosave-dot"></span>已自动保存</span>
                <button class="btn-ghost btn-tiny btn-ghost-danger" onclick="SettingsModule.resetDefaults()" title="将所有设置恢复为默认值">↺ 恢复默认</button>
                <button class="modal-close" onclick="SettingsModule.close()" title="关闭">×</button>
            </div>
        </div>
        <div class="modal-body settings-modal-body">
        <div class="page-header">
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
            <div class="form-row">
                <div class="form-col">
                    <label class="form-label">四宫格去白边裁切（像素）</label>
                    <input type="number" class="form-input" id="imgFgTrim" min="0" max="200" step="1" value="${Number.isFinite(+defs.fgTrim) ? +defs.fgTrim : 0}" onchange="SettingsModule.saveImageDefaults()" placeholder="0">
                    <p class="form-hint">四宫格切分为 4 张时，每个面板四周向内裁掉的像素数，用于去掉宫格之间的白边/分隔线。0 = 不裁切。</p>
                </div>
            </div>
            <div class="form-row">
                <div class="form-col">
                    <label class="form-label">语音前留白（秒）</label>
                    <input type="number" class="form-input" id="imgPadHead" min="0" max="10" step="0.1" value="${Number.isFinite(+defs.audioPadHeadSec) ? +defs.audioPadHeadSec : 0.5}" onchange="SettingsModule.saveImageDefaults()" placeholder="0.5">
                </div>
                <div class="form-col">
                    <label class="form-label">语音后留白（秒）</label>
                    <input type="number" class="form-input" id="imgPadTail" min="0" max="10" step="0.1" value="${Number.isFinite(+defs.audioPadTailSec) ? +defs.audioPadTailSec : 0.5}" onchange="SettingsModule.saveImageDefaults()" placeholder="0.5">
                </div>
            </div>
            <p class="form-hint">时间轴上图像与音频对齐时，图像段会比关联音频多出这段画面：语音开始<strong>前</strong>留白 + 结束<strong>后</strong>留白，避免一开口就切镜、话没说完就转场。各 0 = 画面与音频严格等长。</p>
        </div>

        <div class="settings-section">
            <h2 class="settings-section-title">🔊 语音生成</h2>
            <div class="form-row">
                <div class="form-col">
                    <label class="form-label">默认配音 / 语音克隆工作流（TTS）</label>
                    <select class="form-input" id="ttsWorkflow" onchange="SettingsModule.saveCloneWorkflow(this.value)">
                        <option value="vocpm" ${(voice.cloneWorkflow || 'vocpm') === 'vocpm' ? 'selected' : ''}>VoxCPM</option>
                        <option value="qwen3" ${voice.cloneWorkflow === 'qwen3' ? 'selected' : ''}>Qwen3-TD-TTS</option>
                        <option value="indextts" ${voice.cloneWorkflow === 'indextts' ? 'selected' : ''}>IndexTTS-2（情感）</option>
                    </select>
                </div>
                <div class="form-col">
                    <label class="form-label">默认朗读文本模板</label>
                    <input class="form-input" id="voiceTemplate" value="${this.esc(voice.textTemplate || '我是{name}，这是我的音色，很高兴认识你')}" placeholder="我是{name}，这是我的音色"
                        onchange="SettingsModule.autoSaveVoice(this.value)">
                </div>
            </div>
            <p class="form-hint">配音工作流：人物 / 分镜配音使用的 ComfyUI 工作流，VoxCPM 与 Qwen3-TD-TTS 音色风格略有差异，IndexTTS-2 支持情感维度。朗读文本模板用 <code>{name}</code> 作为人物姓名占位符。</p>
        </div>

        <div class="settings-section">
            <h2 class="settings-section-title">🎬 合成视频默认</h2>
            <div class="form-row">
                <div class="form-col">
                    <label class="form-label">默认合成工作流</label>
                    <select class="form-input" id="vdWorkflow" onchange="SettingsModule.saveVideoDefaults()">
                        <option value="director" ${(s.videoDefaults||{}).workflow==='singularity'?'':'selected'}>旧导演台 LTXDirector</option>
                        <option value="singularity" ${(s.videoDefaults||{}).workflow==='singularity'?'selected':''}>Singularity 乱神版V3</option>
                    </select>
                </div>
                <div class="form-col">
                    <label class="form-label">默认 Epsilon（过渡柔和度）</label>
                    <input type="number" class="form-input" id="vdEpsilon" min="0.001" max="1" step="0.001"
                        value="${Number.isFinite(+(s.videoDefaults||{}).epsilon) ? +(s.videoDefaults||{}).epsilon : 0.9}"
                        onchange="SettingsModule.saveVideoDefaults()" placeholder="0.9">
                </div>
            </div>
            <p class="form-hint">进入「合成视频」时间轴时作为初始值：合成工作流 <code>director</code>(旧导演台) / <code>singularity</code>(乱神版V3)；Epsilon 越小越接近硬切（0.001），越大转场越柔和（1.0）。进入时间轴后仍可临时调整，点「生成视频」时会再次确认工作流。</p>
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
        </div>
        </div>`;

        // 显示弹窗（不影响主内容）
        ov.classList.add('active');

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
            <div class="form-hint" style="margin-top:0.35rem;line-height:1.6">
                💡 使用<b>速创API（wuyinkeji）</b>时：地址填 <code>https://api.wuyinkeji.com</code>，Key 填速创API 密钥，模型可填
                <code>image_nanoBanana2</code> / <code>image_nanoBanana_pro</code> / <code>image_nanoBanana</code> / <code>gpt-image-2</code> / <code>wan2.7</code>，
                系统会自动走其异步接口（参考图照常生效）。
                <button class="btn-ghost btn-tiny" style="margin-left:0.4rem" onclick="SettingsModule.applyWuyinPreset('${g.id}')">⚡ 一键填入速创API</button>
            </div>
        </div>`;
    },

    // 一键把当前分组填成速创API 预设（保留已有 Key，不覆盖）
    applyWuyinPreset(gid) {
        const s = Storage.getSettings();
        const groups = s.imageApiGroups || [];
        const g = groups.find(x => x.id === gid);
        if (!g) return;
        g.url = 'https://api.wuyinkeji.com';
        g.models = ['image_nanoBanana2', 'image_nanoBanana_pro', 'image_nanoBanana', 'gpt-image-2', 'wan2.7'];
        if (!g.name || g.name === '新分组') g.name = '速创API';
        Storage.saveSettings({ imageApiGroups: groups });
        this.render();
        App.showToast('已填入速创API 预设，请补填 API Key', 'success');
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

    autoSaveCloneWorkflow(wf) {
        const s = Storage.getSettings();
        const cloneWorkflow = (wf === 'qwen3') ? 'qwen3' : 'vocpm';
        const voiceSettings = { ...(s.voiceSettings || {}), cloneWorkflow };
        Storage.saveSettings({ voiceSettings });
        this.flashSaved();
    },

    // 默认配音 / 语音克隆工作流（TTS）：支持 vocpm / qwen3 / indextts
    saveCloneWorkflow(wf) {
        const s = Storage.getSettings();
        const allow = ['vocpm', 'qwen3', 'indextts'];
        const cloneWorkflow = allow.includes(wf) ? wf : 'vocpm';
        Storage.saveSettings({ voiceSettings: { ...(s.voiceSettings || {}), cloneWorkflow } });
        this.flashSaved();
    },

    saveImageDefaults() {
        const s = Storage.getSettings();
        let fgTrim = parseInt((document.getElementById('imgFgTrim') || {}).value, 10);
        if (!Number.isFinite(fgTrim) || fgTrim < 0) fgTrim = 0;
        if (fgTrim > 200) fgTrim = 200;
        const clampSec = (id, def) => {
            let v = parseFloat((document.getElementById(id) || {}).value);
            if (!Number.isFinite(v) || v < 0) v = def;
            if (v > 10) v = 10;
            return v;
        };
        const audioPadHeadSec = clampSec('imgPadHead', 0.5);
        const audioPadTailSec = clampSec('imgPadTail', 0.5);
        const defs = {
            ...(s.imageDefaults || {}),
            quality: document.getElementById('imgQuality').value,
            size: document.getElementById('imgSize').value,
            fgTrim,
            audioPadHeadSec,
            audioPadTailSec
        };
        Storage.saveSettings({ imageDefaults: defs });
        this.flashSaved();
    },

    // 保存合成视频默认参数（默认合成工作流 + 默认 Epsilon），供 openTimeline 读取为初始值
    saveVideoDefaults() {
        const s = Storage.getSettings();
        const wfRaw = (document.getElementById('vdWorkflow') || {}).value;
        const workflow = (wfRaw === 'singularity') ? 'singularity' : 'director';
        let epsilon = parseFloat((document.getElementById('vdEpsilon') || {}).value);
        if (!Number.isFinite(epsilon)) epsilon = 0.9;
        if (epsilon < 0.001) epsilon = 0.001;
        if (epsilon > 1) epsilon = 1;
        const videoDefaults = { ...(s.videoDefaults || {}), workflow, epsilon };
        Storage.saveSettings({ videoDefaults });
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
