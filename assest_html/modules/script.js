const ScriptModule = {
    projectId: null,
    _EXTRACT_TASK_KEY: 'assest_extract_task',   // localStorage：进行中的提取任务（刷新/切 tab 不丢）
    _EXTRACT_RESULT_KEY: 'assest_extract_result', // localStorage：上次提取的结果横幅（常驻，手动关或下次覆盖）
    _extractPolling: false,
    _extractTimer: null,

    render(projectId) {
        this.projectId = projectId;
        const project = Storage.getProject(projectId);
        const tabContent = document.getElementById('tabContent');

        const task = this._loadExtractTask();
        const elapsed = task ? Math.round((Date.now() - (task.start || Date.now())) / 1000) : 0;
        const extractBtnHtml = task
            ? `<button class="btn-secondary btn-disabled" id="extractMainBtn" disabled><span class="sb-spinner sb-spinner-inline"></span><span id="extractMainTimer">提取中 ${elapsed}s</span></button>
               <button class="btn-secondary sb-stop-btn" onclick="ScriptModule.stopExtract()" title="停止跟踪本次提取（后台任务可能仍在运行，但前端不再等待）">⏹ 停止</button>`
            : `<button class="btn-secondary" id="extractMainBtn" onclick="ScriptModule.showExtractModal()">✨ 提取人物/道具/场景</button>`;

        tabContent.innerHTML = `
            <div class="form-group">
                <label class="form-label">剧本内容</label>
                <textarea class="form-textarea script-textarea" id="scriptEditor" placeholder="在这里输入剧本内容..."
                >${this.escapeHtml(project.script)}</textarea>
            </div>
            <div class="btn-group">
                <button class="btn-primary" onclick="ScriptModule.saveScript()">💾 保存剧本</button>
                <button class="btn-primary" onclick="ScriptModule.exportScript()">📥 导出TXT</button>
                ${extractBtnHtml}
            </div>
            ${this._resultBannerHtml()}
        `;
        // 恢复进行中的提取任务（刷新/切 tab 回来后继续轮询、按钮保持置灰转圈）
        this._resumeExtractTask();
    },

    saveScript() {
        const editor = document.getElementById('scriptEditor');
        Storage.updateProject(this.projectId, { script: editor.value });
        App.showToast('剧本已保存', 'success');
    },

    exportScript() {
        const project = Storage.getProject(this.projectId);
        const script = document.getElementById('scriptEditor').value;
        const blob = new Blob([script], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${project.name}_剧本.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        App.showToast('剧本已导出', 'success');
    },

    showExtractModal() {
        const editor = document.getElementById('scriptEditor');
        const script = editor.value;
        const settings = Storage.getSettings();
        if (!script.trim()) { App.showToast('请先输入剧本内容', 'error'); return; }

        const wordCount = script.replace(/\s/g, '').length;
        const modalContent = document.getElementById('modalContent');
        modalContent.innerHTML = `
            <div class="modal-header">
                <h2 class="modal-title">✨ 提取人物 / 道具 / 场景</h2>
                <button class="modal-close" onclick="App.closeModal()">×</button>
            </div>
            <div class="modal-body">
                <div class="extract-intro">
                    <div class="extract-intro-icon">🎬</div>
                    <div class="extract-intro-text">
                        <div class="extract-intro-title">智能提取</div>
                        <div class="extract-intro-sub">将调用 Claude Code 分析剧本（约 ${wordCount} 字），自动识别人物、道具与场景</div>
                    </div>
                </div>
                <div class="form-group">
                    <div class="prompt-editor-head">
                        <label class="form-label" style="margin:0">提取提示词</label>
                        <button type="button" class="btn-ghost btn-tiny" onclick="ScriptModule.toggleExtractPrompt(this)">收起 ▴</button>
                    </div>
                    <textarea class="form-textarea prompt-editor" id="extractPrompt" oninput="ScriptModule._updPromptCount()">${this.escapeHtml(settings.globalPrompt)}</textarea>
                    <div class="prompt-editor-foot">
                        <span class="hint-text">可临时调整本次提取的提示词</span>
                        <span class="char-counter" id="extractPromptCount">0 字</span>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">提示词保存方式</label>
                    <div class="radio-card-group">
                        <label class="radio-card selected"><input type="radio" name="savePrompt" value="none" checked onchange="ScriptModule._syncRadioCards(this)"><span class="radio-card-dot"></span><span class="radio-card-label">仅本次使用<small>不修改全局设置</small></span></label>
                        <label class="radio-card"><input type="radio" name="savePrompt" value="global" onchange="ScriptModule._syncRadioCards(this)"><span class="radio-card-dot"></span><span class="radio-card-label">更新全局提示词<small>保存到设置，后续默认使用</small></span></label>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" onclick="ScriptModule.extractAll()">🚀 开始提取</button>
            </div>
        `;
        document.getElementById('modalOverlay').classList.add('active');
        this._updPromptCount();
    },

    _updPromptCount() {
        const ta = document.getElementById('extractPrompt');
        const c = document.getElementById('extractPromptCount');
        if (ta && c) c.textContent = `${ta.value.length} 字`;
    },
    toggleExtractPrompt(btn) {
        const ta = document.getElementById('extractPrompt');
        if (!ta) return;
        const collapsed = ta.classList.toggle('collapsed');
        btn.textContent = collapsed ? '展开 ▾' : '收起 ▴';
    },
    _syncRadioCards(input) {
        document.querySelectorAll('.radio-card').forEach(c => c.classList.remove('selected'));
        const card = input.closest('.radio-card');
        if (card) card.classList.add('selected');
    },

    // 提交『提取人物/道具/场景』异步任务：提交成功后立即关闭弹窗、重渲染按钮（置灰转圈 + 秒数 + 停止），
    // 任务在后台运行，刷新/切 tab 回来仍可恢复跟踪。
    async extractAll() {
        const prompt = document.getElementById('extractPrompt').value;
        const saveOption = document.querySelector('input[name="savePrompt"]:checked').value;
        const project = Storage.getProject(this.projectId);
        if (saveOption === 'global') Storage.saveSettings({ globalPrompt: prompt });

        const footerBtn = document.querySelector('.modal-footer .btn-primary');
        if (footerBtn) { footerBtn.disabled = true; footerBtn.textContent = '⏳ 提交中…'; }

        try {
            const submit = await API.post('/api/extract_characters', {
                project_id: this.projectId,
                project_name: project.name,
                script: project.script,
                prompt: prompt,
            });
            if (!submit.success || !submit.task_id) throw new Error(submit.error || '提交失败');

            this._saveExtractTask({ taskId: submit.task_id, projectId: this.projectId, start: Date.now() });
            try { localStorage.removeItem(this._EXTRACT_RESULT_KEY); } catch (e) {}  // 新任务覆盖上次结果横幅
            App.showToast('✨ 已提交，Claude 正在后台提取人物/道具/场景，可关闭弹窗继续等待', 'info');
            App.closeModal();
            // 重渲染剧本页：按钮置灰转圈 + 秒数（render 末尾的 _resumeExtractTask 接管轮询与计时）
            if (this.projectId) this.render(this.projectId);
        } catch (error) {
            App.showToast('❌ 提交失败：' + (error.message || '未知错误'), 'error');
            if (footerBtn) { footerBtn.disabled = false; footerBtn.textContent = '🚀 开始提取'; }
        }
    },

    // ===== 提取任务：持久化 / 恢复 / 轮询 / 计时 / 停止 =====
    _saveExtractTask(task) {
        try { localStorage.setItem(this._EXTRACT_TASK_KEY, JSON.stringify(task)); } catch (e) {}
    },
    _loadExtractTask() {
        try {
            const raw = localStorage.getItem(this._EXTRACT_TASK_KEY);
            if (!raw) return null;
            const t = JSON.parse(raw);
            // 超过 15 分钟视为过期
            if (!t || !t.taskId || Date.now() - (t.start || 0) > 900000) { this._clearExtractTask(); return null; }
            return t;
        } catch (e) { return null; }
    },
    _clearExtractTask() { try { localStorage.removeItem(this._EXTRACT_TASK_KEY); } catch (e) {} },

    _startExtractTimer() {
        this._stopExtractTimer();
        const tick = () => {
            const t = this._loadExtractTask();
            const timer = document.getElementById('extractMainTimer');
            if (!t || !timer) return;
            const sec = Math.round((Date.now() - (t.start || Date.now())) / 1000);
            timer.textContent = `提取中 ${sec}s`;
        };
        tick();
        this._extractTimer = setInterval(tick, 1000);
    },
    _stopExtractTimer() {
        if (this._extractTimer) { clearInterval(this._extractTimer); this._extractTimer = null; }
    },

    // ⏹ 停止：仅前端停止跟踪（清任务、停轮询、停计时器，按钮恢复可点）。
    async stopExtract() {
        if (!this._loadExtractTask()) return;
        const ok = await App.confirm({
            title: '⏹ 停止提取',
            message: '停止跟踪本次提取？\n\n前端会立即恢复按钮；后台任务可能仍在运行，但其结果将不再自动写入。',
            okText: '停止跟踪',
            cancelText: '继续等待',
            danger: true,
        });
        if (!ok) return;
        this._extractPolling = false;
        this._clearExtractTask();
        this._stopExtractTimer();
        App.showToast('⏹ 已停止跟踪本次提取', 'info');
        if (this.projectId) this.render(this.projectId);
    },

    // 恢复进行中的提取任务（render 时调用）
    _resumeExtractTask() {
        const t = this._loadExtractTask();
        if (!t) { this._stopExtractTimer(); return; }
        this._startExtractTimer();
        if (!this._extractPolling) this._pollExtractTask();
    },

    // 轮询提取任务（全局唯一，结果回写 + toast）
    async _pollExtractTask() {
        const t = this._loadExtractTask();
        if (!t) { this._extractPolling = false; return; }
        this._extractPolling = true;
        try {
            const r = await API.post('/api/sb_task', { task_id: t.taskId });
            if (r.status === 'done') {
                this._extractPolling = false; this._clearExtractTask(); this._stopExtractTimer();
                this._applyExtractResult(r.result || {});
                if (this.projectId) this.render(this.projectId);
                return;
            }
            if (r.status === 'error' || r.status === 'missing') {
                this._extractPolling = false; this._clearExtractTask(); this._stopExtractTimer();
                const msg = r.status === 'missing' ? '任务已失效（服务可能已重启）' : (r.error || '提取失败');
                this._saveExtractResult({ ok: false, text: '提取失败：' + msg, ts: Date.now() });
                if (this.projectId) this.render(this.projectId);
                return;
            }
            // running / pending
            setTimeout(() => this._pollExtractTask(), 2000);
        } catch (e) {
            setTimeout(() => this._pollExtractTask(), 3500);  // 网络抖动退避
        }
    },

    // 把提取结果合并到资产库，并写入常驻结果横幅（不自动消失）
    _applyExtractResult(data) {
        const project = Storage.getProject(this.projectId);
        const existingChars = project ? (project.characters || []) : [];
        const existingProps = project ? (project.props || []) : [];
        const existingScenes = project ? (project.scenes || []) : [];

        const stats = [];
        stats.push(this.mergeItems(existingChars, 'characters', data.characters || []));
        stats.push(this.mergeItems(existingProps, 'props', data.props || []));
        stats.push(this.mergeItems(existingScenes, 'scenes', data.scenes || []));

        const summary = stats.map(s => `${s.label} +${s.added}/更新${s.updated}`).join(' · ');
        this._saveExtractResult({ ok: true, text: '提取完成：' + summary, ts: Date.now() });
    },

    // ===== 常驻结果横幅（成功/失败，手动叉掉或下次提取覆盖）=====
    _saveExtractResult(r) {
        try { localStorage.setItem(this._EXTRACT_RESULT_KEY, JSON.stringify(r)); } catch (e) {}
    },
    _loadExtractResult() {
        try { return JSON.parse(localStorage.getItem(this._EXTRACT_RESULT_KEY) || 'null'); } catch (e) { return null; }
    },
    dismissExtractResult() {
        try { localStorage.removeItem(this._EXTRACT_RESULT_KEY); } catch (e) {}
        const el = document.getElementById('extractResultBanner');
        if (el) el.remove();
    },
    _resultBannerHtml() {
        const r = this._loadExtractResult();
        if (!r || !r.text) return '';
        const cls = r.ok ? 'ok' : 'err';
        const icon = r.ok ? '✅' : '❌';
        return `<div class="gen-result-banner ${cls}" id="extractResultBanner">
            <span class="gen-result-icon">${icon}</span>
            <span class="gen-result-text">${this.escapeHtml(r.text)}</span>
            <button class="gen-result-close" title="关闭" onclick="ScriptModule.dismissExtractResult()">×</button>
        </div>`;
    },

    mergeItems(existingItems, type, ccItems) {
        let updated = 0, added = 0, kept = 0;
        const ccNames = ccItems.map(c => c.name);

        ccItems.forEach(ccItem => {
            const existing = existingItems.find(e => e.name === ccItem.name);
            if (existing) {
                Storage.updateItem(this.projectId, type, existing.id, {
                    description: ccItem.description || ccItem.appearance || '',
                    voice: ccItem.voice || '',
                    name: ccItem.name,
                    source: 'cc'
                });
                updated++;
            } else {
                Storage.addItem(this.projectId, type, {
                    name: ccItem.name,
                    description: ccItem.description || ccItem.appearance || '',
                    voice: ccItem.voice || '',
                    source: 'cc'
                });
                added++;
            }
        });

        kept = existingItems.filter(e => !ccNames.includes(e.name)).length;
        const labels = { characters: '人物', props: '道具', scenes: '场景' };
        return { label: labels[type] || type, updated, added, kept };
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
