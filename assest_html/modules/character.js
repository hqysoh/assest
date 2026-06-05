const CharacterModule = {
    projectId: null,
    _currentAudio: null,
    _imageViewer: { scale: 1 },
    _genTasks: {},   // id -> 开始时间戳（供计时器/进度条 UI 读取，保持兼容）
    _genTimers: {},  // id -> setTimeout 句柄（计时器 UI）
    _genJobs: {},    // id -> { taskId, module, projectId, start }（用于刷新后凭 taskId 取回结果）
    _genPolls: {},   // id -> setTimeout 句柄（结果轮询）
    _ttsTasks: {},
    _ttsTimers: {},

    _saveTaskState() {
        const state = { genTasks: this._genTasks, genJobs: this._genJobs, ttsTasks: this._ttsTasks };
        try { localStorage.setItem('assest_tasks', JSON.stringify(state)); } catch(e) {}
    },
    _restoreTaskState() {
        try {
            const raw = localStorage.getItem('assest_tasks');
            if (!raw) return;
            const state = JSON.parse(raw);
            const now = Date.now();
            for (const cid in (state.genTasks || {})) {
                if (now - state.genTasks[cid] < 600000) this._genTasks[cid] = state.genTasks[cid];
            }
            for (const cid in (state.genJobs || {})) {
                const job = state.genJobs[cid];
                if (job && job.taskId && (now - (job.start || 0) < 600000)) this._genJobs[cid] = job;
            }
            for (const cid in (state.ttsTasks || {})) {
                if (now - state.ttsTasks[cid] < 600000) this._ttsTasks[cid] = state.ttsTasks[cid];
            }
            // 刷新/重进后，对仍持有 taskId 的图像任务继续轮询，拿回后端已生成的结果（避免浪费）
            for (const cid in this._genJobs) {
                if (!this._genPolls[cid]) this._pollImageJob(cid);
            }
            if (Object.keys(this._genTasks).length || Object.keys(this._ttsTasks).length) {
                console.log('已恢复进行中的生成任务，正在向后端取回结果…');
            }
        } catch(e) {}
    },

    // 把异步任务生成出的图片写回对应模块的存储（按 module 分派）
    async _saveGeneratedImage(job, imgData) {
        const dims = await this.computeDims(imgData);
        const pid = job.projectId, id = job.id;
        if (job.module === 'characters') {
            await Storage.addCharacterImage(pid, id, imgData, dims);
        } else { // props / scenes / storyboards
            await Storage.addItemImage(pid, job.module, id, imgData, dims);
        }
    },

    // 把图像生成错误写回对应条目（按 module 分派），供刷新后仍显示的小标签使用
    _setGenError(module, projectId, id, msg) {
        try {
            const p = Storage.getProject(projectId);
            if (!p) return;
            if (module === 'characters') {
                const c = (p.characters || []).find(x => x.id === id);
                if (c) { c.lastGenError = msg || ''; Storage.updateProject(projectId, { characters: p.characters }); }
            } else if (module === 'storyboards') {
                // 分镜四宫格走自己的 fourGridError，这里不处理
            } else {
                const arr = p[module] || [];
                const it = arr.find(x => x.id === id);
                if (it) { it.lastGenError = msg || ''; Storage.updateProject(projectId, { [module]: arr }); }
            }
        } catch (e) {}
    },

    // 重新渲染发起任务的那个模块列表（拿回结果或失败后刷新界面）
    _rerenderJobModule(job) {
        try {
            if (job.module === 'characters') { if (this.projectId) this.render(this.projectId); }
            else if (job.module === 'storyboards') { if (StoryboardModule.projectId) StoryboardModule.render(StoryboardModule.projectId); }
            else { if (PropsScenesModule.projectId === job.projectId) PropsScenesModule.render(job.projectId, job.module); }
        } catch (e) {}
    },

    _clearGenTask(id) {
        if (this._genTimers[id]) { clearTimeout(this._genTimers[id]); delete this._genTimers[id]; }
        if (this._genPolls[id]) { clearTimeout(this._genPolls[id]); delete this._genPolls[id]; }
        delete this._genTasks[id];
        delete this._genJobs[id];
        this._saveTaskState();
    },

    // 提交异步图像任务并开始轮询；ctx 包含 { id, module, projectId, prompt, apiUrl, apiKey, model, size, quality }
    async _startImageJob(ctx) {
        const id = ctx.id;
        const start = Date.now();
        this._genTasks[id] = start;
        // 生成开始即清除该条目上一次的错误（生成过程中不再显示旧错误标签）
        this._setGenError(ctx.module, ctx.projectId, id, '');
        this._rerenderJobModule({ module: ctx.module, projectId: ctx.projectId });
        try {
            const r = await fetch(API.url('/api/generate_image_async'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: ctx.prompt, api_url: ctx.apiUrl, api_key: ctx.apiKey,
                    model: ctx.model, size: ctx.size, quality: ctx.quality
                })
            });
            const d = await r.json();
            if (!d.success || !d.task_id) {
                this._setGenError(ctx.module, ctx.projectId, id, d.error || '任务提交失败');
                this._clearGenTask(id);
                this._rerenderJobModule({ module: ctx.module, projectId: ctx.projectId });
                return { ok: false, error: d.error || '任务提交失败' };
            }
            this._genJobs[id] = { taskId: d.task_id, module: ctx.module, projectId: ctx.projectId, id, start };
            this._saveTaskState();
            this._pollImageJob(id);
            return { ok: true, taskId: d.task_id };
        } catch (e) {
            this._setGenError(ctx.module, ctx.projectId, id, e.message || '网络错误');
            this._clearGenTask(id);
            this._rerenderJobModule({ module: ctx.module, projectId: ctx.projectId });
            return { ok: false, error: e.message };
        }
    },

    // 轮询单个图像任务结果；done 写回并刷新，error 提示，missing/超时放弃
    async _pollImageJob(id) {
        const job = this._genJobs[id];
        if (!job) return;
        // 超过 10 分钟仍未完成则放弃，避免无限轮询
        if (Date.now() - (job.start || 0) > 600000) { this._clearGenTask(id); this._rerenderJobModule(job); return; }
        try {
            const r = await fetch(API.url('/api/image_task'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ task_id: job.taskId })
            });
            const d = await r.json();
            if (d.status === 'done' && d.images && d.images.length) {
                const imgData = 'data:image/png;base64,' + d.images[0];
                await this._saveGeneratedImage(job, imgData);
                this._setGenError(job.module, job.projectId, job.id, '');  // 成功 → 清除旧错误
                this._clearGenTask(id);
                App.showToast('✅ 图像已生成', 'success');
                this._rerenderJobModule(job);
                this._onJobResultUI(id, { ok: true, imgData });
                return;
            }
            if (d.status === 'error') {
                this._setGenError(job.module, job.projectId, job.id, d.error || '未知错误');
                this._clearGenTask(id);
                App.showToast('❌ 图像生成失败: ' + (d.error || '未知错误'), 'error');
                this._rerenderJobModule(job);
                this._onJobResultUI(id, { ok: false, error: d.error });
                return;
            }
            if (d.status === 'missing') {
                // 后端重启或结果过期：任务已无法取回，放弃
                this._setGenError(job.module, job.projectId, job.id, '任务已失效（服务可能已重启），请重试');
                this._clearGenTask(id);
                this._rerenderJobModule(job);
                this._onJobResultUI(id, { ok: false, error: '任务已失效（服务可能已重启）' });
                return;
            }
            // pending：继续轮询
            this._genPolls[id] = setTimeout(() => this._pollImageJob(id), 2000);
        } catch (e) {
            // 网络抖动：稍后重试
            this._genPolls[id] = setTimeout(() => this._pollImageJob(id), 3000);
        }
    },

    // 若生成弹窗仍打开，更新其结果区（可被各模块覆盖具体表现）
    _onJobResultUI(id, res) {
        const cb = this._genUICallbacks && this._genUICallbacks[id];
        if (cb) { try { cb(res); } catch (e) {} delete this._genUICallbacks[id]; }
    },
    _genUICallbacks: {},

    // 图像生成错误小标签（点击查看完整错误，× 可关闭，宽度跟随图像 124px 单行省略）
    // clearCall：× 按钮的清除表达式（如 "CharacterModule.clearGenError('id')"），不同模块各传各的
    genErrorTag(msg, clearCall) {
        const full = encodeURIComponent(String(msg || ''));
        const brief = String(msg || '').replace(/\s+/g, ' ').slice(0, 14);
        return `<div class="gen-err-tag" title="点击查看完整错误" onclick="CharacterModule.showGenError('${full}')">`
            + `<span class="gen-err-txt">⚠️ ${this.esc(brief)}${String(msg).length > 14 ? '…' : ''}</span>`
            + (clearCall ? `<span class="gen-err-x" title="忽略" onclick="event.stopPropagation();${clearCall}">✕</span>` : '')
            + `</div>`;
    },

    // 弹出完整错误信息（应用内弹窗，兼容 IDE WebView）
    showGenError(enc) {
        const msg = decodeURIComponent(enc || '');
        App.confirm({ title: '❌ 图像生成失败', message: msg || '未知错误', okText: '知道了', cancelText: '关闭' });
    },

    // × 关闭：清除该卡片的生成错误并重渲染
    clearGenError(cid) {
        if (!cid) return;
        const p = Storage.getProject(this.projectId);
        if (!p) return;
        const c = (p.characters || []).find(x => String(x.id) === String(cid));
        if (c && c.lastGenError) {
            delete c.lastGenError;
            Storage.saveProject(p);
        }
        this.render(this.projectId);
    },

    render(projectId) {
        this.projectId = projectId;
        this._restoreTaskState();
        const p = Storage.getProject(projectId);
        if (!p) return;
        const chars = p.characters || [];
        const tab = document.getElementById('tabContent');
        const rows = chars.map((c, i) => this.renderRow(c, i)).join('');
        tab.innerHTML = `<div class="list-container">${rows || '<div class="empty-state"><div class="empty-state-icon">👥</div><div class="empty-state-text">暂无人物，请先提取或添加</div></div>'}<div class="list-add-bar" onclick="CharacterModule.showAddCharacterModal()"><span>+ 添加人物</span></div></div>`;

        // 切换tab回来后恢复进度条更新
        Object.keys(this._genTasks).forEach(cid => {
            if (this._genTimers[cid]) clearTimeout(this._genTimers[cid]);
            this.renderRowUpdate(cid);
        });
        // 恢复TTS计时器
        Object.keys(this._ttsTasks).forEach(cid => {
            if (this._ttsTimers[cid]) clearTimeout(this._ttsTimers[cid]);
            this.ttsRowUpdate(cid);
        });
    },

    renderRow(c, idx) {
        const img = Storage.getSelectedMedia(this.projectId, 'characters', c, 'image');
        const au = Storage.getSelectedMedia(this.projectId, 'characters', c, 'audio');
        const srcTag = c.source === 'cc' ? 'cc' : 'man';
        const dimInfo = this.imgDimLabel(img);
        const genTask = this._genTasks[c.id];
        const elapsedSec = genTask ? Math.round((Date.now() - genTask) / 1000) : 0;
        const barPct = genTask ? Math.min(elapsedSec * 3, 90) : 0;
        const genOverlay = genTask ? this.genOverlayHtml(c.id, elapsedSec, barPct) : '';
        // TTS progress
        const ttsTask = this._ttsTasks[c.id];
        const ttsElapsedSec = ttsTask ? Math.round((Date.now() - ttsTask) / 1000) : 0;
        return `<div class="list-row">
            <div class="list-row-img-section" data-drop-kind="char" data-drop-id="${c.id}">
                <div class="list-row-img" onclick="CharacterModule.openImageZoom('${img ? Storage.mediaUrl(img.data) : ''}','${this.esc(c.name)}','${dimInfo}')" style="position:relative">
                    ${img ? `<img src="${Storage.mediaUrl(img.data)}" alt="" onload="CharacterModule.onImgLoad(this,'${dimInfo}')">` : `<div class="placeholder-lg">👤</div>`}
                    ${genOverlay}
                    <div class="drop-add-overlay"><span class="drop-add-plus">＋</span><span class="drop-add-text">松开上传图片</span></div>
                </div>
                ${img ? `<span class="gen-img-label">${dimInfo}</span>` : ''}
                ${(!genTask && c.lastGenError) ? this.genErrorTag(c.lastGenError, `CharacterModule.clearGenError('${c.id}')`) : ''}
                <div class="list-img-btns">
                    <button class="btn-ghost btn-tiny ${genTask ? 'btn-disabled' : ''}" id="genCardBtn_${c.id}" onclick="${genTask ? '' : `CharacterModule.generateImage('${c.id}')`}">${genTask ? '⏳ 生成' : '🎨 生成'}</button>
                    <button class="btn-ghost btn-tiny" onclick="CharacterModule.uploadImage('${c.id}')">📁 上传</button>
                    <button class="btn-ghost btn-tiny" onclick="CharacterModule.showHistoryModal('${c.id}')">📷 历史</button>
                </div>
            </div>
            <div class="list-row-body">
                <div class="list-row-header">
                    <span class="list-row-no">${idx + 1}.</span>
                    ${InlineEdit.field(c.name, { single: true, placeholder: '未命名',
                        className: 'list-row-name-edit',
                        data: { edit: 'char', id: c.id, field: 'name' } })}
                    <span class="tag-${srcTag}">${c.source === 'cc' ? '🤖 CC' : '✍️ 手动'}</span>
                </div>
                <div class="list-row-top-right">
                    <button class="btn-ghost btn-ghost-danger btn-tiny" onclick="CharacterModule.del('${c.id}')">🗑️ 删除</button>
                </div>
                <div class="list-row-meta">
                    <div class="meta-section">
                        <div class="meta-header">
                            <span class="meta-label">外貌</span>
                        </div>
                        ${InlineEdit.field(c.appearance || c.description || '', {
                            placeholder: '点击填写人物外貌…',
                            className: 'meta-content',
                            data: { edit: 'char', id: c.id, field: 'appearance' } })}
                    </div>
                    <div class="meta-section">
                        <div class="meta-header">
                            <span class="meta-label">音色</span>
                            <div class="meta-item-btns">
                                <button class="btn-ghost btn-tiny ${ttsTask ? 'btn-disabled' : ''}" id="ttsGenListBtn_${c.id}" onclick="${ttsTask ? '' : `CharacterModule.showTtsModal('${c.id}')`}">${ttsTask ? `<span id="ttsTime_${c.id}">⏳ ${ttsElapsedSec}s</span>` : '🔊 生成'}</button>
                                ${au ? `<button class="btn-play btn-tiny" id="ab_${c.id}" onclick="CharacterModule.toggleAudio('${c.id}')">▶ 播放</button>` : ''}
                                ${au ? `<span class="audio-history-link" onclick="CharacterModule.showAudioHistory('${c.id}')">历史</span>` : ''}
                                <audio id="ae_${c.id}" style="display:none" onended="document.getElementById('ab_${c.id}').textContent='▶ 播放'; CharacterModule._currentAudio=null;"><source src="${au ? Storage.mediaUrl(au.data) : ''}" type="${au ? (au.mime || 'audio/wav') : ''}"></audio>
                            </div>
                        </div>
                        ${InlineEdit.field(c.voice || '', {
                            placeholder: '点击填写音色描述…',
                            className: 'meta-content',
                            data: { edit: 'char', id: c.id, field: 'voice' } })}
                    </div>
                </div>
            </div>
        </div>`;
    },

    showTtsModal(cid) {
        const p = Storage.getProject(this.projectId);
        const c = p.characters.find(x => x.id === cid); if (!c) return;
        const settings = Storage.getSettings();
        const tmpl = settings.voiceSettings && settings.voiceSettings.textTemplate ? settings.voiceSettings.textTemplate : "我是{name}，这是我的音色，很高兴认识你";
        const defaultText = c.ttsText || tmpl.replace('{name}', c.name);
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">生成音频 - ${this.esc(c.name)}</h2></div>
        <div class="modal-body">
            <div class="form-group"><label class="form-label">音色描述</label><textarea class="form-textarea" id="ttsVoice" style="min-height:60px">${this.esc(c.voice || '')}</textarea></div>
            <div class="form-group"><label class="form-label">要说的文本</label><textarea class="form-textarea" id="ttsText" style="min-height:60px">${this.esc(defaultText)}</textarea></div>
            <p style="font-size:0.72rem;color:var(--t3)">默认模板: ${this.esc(tmpl)} (在设置中修改)</p>
            <div id="ttsResult" style="margin-top:0.75rem"></div>
        </div>
        <div class="modal-footer"><button class="btn-secondary" id="ttsCloseBtn" onclick="App.closeModal()">关闭</button><button class="btn-primary" id="ttsGenBtn" onclick="CharacterModule.doGenerateVoice('${cid}')">▶ 生成</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    async doGenerateVoice(cid) {
        const p = Storage.getProject(this.projectId);
        const c = p.characters.find(x => x.id === cid); if (!c) return;
        const voiceDesc = document.getElementById('ttsVoice').value.trim();
        const ttsText = document.getElementById('ttsText').value.trim();
        if (!ttsText) { App.showToast('请输入文本', 'error'); return; }

        // Save voice/text immediately so list updates even if modal is closed
        c.voice = voiceDesc;
        c.ttsText = ttsText;
        Storage.updateProject(this.projectId, { characters: p.characters });
        this.render(this.projectId);

        const genBtn = document.getElementById('ttsGenBtn');
        const closeBtn = document.getElementById('ttsCloseBtn');
        const resultDiv = document.getElementById('ttsResult');
        const startTime = Date.now();

        // Start TTS progress tracking (modal can be closed)
        this._ttsTasks[cid] = startTime;
        this._saveTaskState();
        this.render(this.projectId);

        genBtn.disabled = true; genBtn.textContent = '⏳ 0s';
        // Allow closing modal during generation (like image generation)
        if (closeBtn) closeBtn.disabled = false;
        resultDiv.innerHTML = `<div class="loading"><div class="loading-spinner"></div></div><p style="text-align:center;font-size:0.8rem;color:var(--t2);">正在通过 ComfyUI TTS 生成音色...</p>`;

        let progressTimer = setInterval(() => {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            genBtn.textContent = `⏳ ${elapsed}s`;
            if (elapsed > 120 && resultDiv) resultDiv.innerHTML += '<p style="text-align:center;color:var(--warn);font-size:0.75rem">⏰ 已超过2分钟</p>';
        }, 1000);

        try {
            const r = await fetch(API.url('/api/generate_voice'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ character_name: c.name, voice_desc: voiceDesc, project_id: this.projectId, text: ttsText, task_id: Date.now().toString() }) });
            const d = await r.json();
            clearInterval(progressTimer);
            if (this._ttsTimers[cid]) { clearTimeout(this._ttsTimers[cid]); delete this._ttsTimers[cid]; }
            delete this._ttsTasks[cid]; this._saveTaskState();

            if (d.success) {
                const audioDataUrl = 'data:audio/wav;base64,' + d.audio_base64;
                const e = await Storage.addItemAudio(this.projectId, 'characters', cid, audioDataUrl, 'audio/wav');
                console.log('TTS: 音频已保存', e ? e.id : 'FAILED');

                // 无论弹窗是否关闭，都更新界面
                try {
                    genBtn.textContent = '✅ 完成'; genBtn.disabled = false;
                    genBtn.onclick = function() { App.closeModal(); };
                    if (closeBtn) closeBtn.disabled = false;
                    resultDiv.innerHTML = `<div style="text-align:center;padding:0.5rem;background:var(--bg3);border-radius:8px;border:1px solid var(--ok)">
                        <p style="color:var(--ok);font-weight:600;margin-bottom:0.5rem">✅ 音频已生成</p>
                        <audio id="ttsPreviewAudio" src="${Storage.mediaUrl(e ? e.data : audioDataUrl)}" style="width:100%;max-width:320px" controls></audio>
                    </div>`;
                } catch (ex) { console.warn('TTS: 弹窗已关闭，跳过UI更新'); }
            } else { throw new Error(d.error || '生成失败'); }
        } catch (e) {
            clearInterval(progressTimer);
            if (this._ttsTimers[cid]) { clearTimeout(this._ttsTimers[cid]); delete this._ttsTimers[cid]; }
            delete this._ttsTasks[cid]; this._saveTaskState();
            genBtn.textContent = '▶ 重试'; genBtn.disabled = false;
            if (closeBtn) closeBtn.disabled = false;
            resultDiv.innerHTML = `<p style="text-align:center;color:var(--err);">❌ ${this.esc(e.message)}</p>`;
        }
        this.render(this.projectId);
    },

    toggleAudio(cid) { const a = document.getElementById('ae_' + cid), b = document.getElementById('ab_' + cid); if (!a || !b) return; if (a.paused) { if (this._currentAudio && this._currentAudio !== a) { this._currentAudio.pause(); const prevBtn = document.getElementById(this._currentAudio._btnId); if (prevBtn) prevBtn.textContent = '▶ 播放'; } a.play(); this._currentAudio = a; a._btnId = 'ab_' + cid; b.textContent = '⏸ 暂停'; } else { a.pause(); b.textContent = '▶ 播放'; this._currentAudio = null; } },

    showAudioHistory(cid) {
        const p = Storage.getProject(this.projectId), c = p.characters.find(x => x.id === cid);
        if (!c) return;
        const audios = Storage.getMediaForItem(this.projectId, 'characters', cid).filter(m => m.type === 'audio');
        if (!audios.length) return;
        const mc = document.getElementById('modalContent');
        const listHtml = audios.map((a, idx) => {
            const isCur = a.id === c.selectedAudio;
            return `<div class="audio-history-item ${isCur ? 'selected' : ''}">
                <div class="audio-wave-icon ${isCur ? 'playing' : ''}"><span></span><span></span><span></span><span></span></div>
                <div class="audio-history-meta">
                    <div class="audio-history-title">音色 #${idx + 1} ${isCur ? '<span class="audio-cur-tag">当前</span>' : ''}</div>
                    <div class="audio-history-time">${new Date(a.createdAt).toLocaleString('zh-CN')}</div>
                </div>
                <audio id="ha_${a.id}" src="${Storage.mediaUrl(a.data)}" style="display:none" onended="document.getElementById('hp_${a.id}').textContent='▶'; CharacterModule._currentAudio=null;"></audio>
                <div class="audio-history-actions">
                    <button class="btn-play audio-play-btn" id="hp_${a.id}" onclick="CharacterModule.tHA('${a.id}')">▶</button>
                    <button class="gallery-select-btn" title="设为当前" onclick="CharacterModule.selA('${cid}','${a.id}')">✓</button>
                    <button class="gallery-delete-btn" title="删除" onclick="CharacterModule.delA('${cid}','${a.id}')">×</button>
                </div>
            </div>`;
        }).join('');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">🔊 音频历史 · ${this.esc(c.name)}</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
        <div class="modal-body"><div class="gallery-count">共 ${audios.length} 条音频</div><div class="audio-history-list">${listHtml}</div></div>
        <div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">关闭</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    tHA(aid) {
        const a = document.getElementById('ha_' + aid), b = document.getElementById('hp_' + aid);
        if (!a || !b) return;
        const wave = b.closest('.audio-history-item')?.querySelector('.audio-wave-icon');
        const clearAll = () => document.querySelectorAll('.audio-wave-icon.playing').forEach(w => w.classList.remove('playing'));
        a.onended = () => { b.textContent = '▶'; if (wave) wave.classList.remove('playing'); this._currentAudio = null; };
        if (a.paused) {
            if (this._currentAudio && this._currentAudio !== a) { this._currentAudio.pause(); const prevBtn = document.getElementById(this._currentAudio._btnId); if (prevBtn) prevBtn.textContent = '▶'; }
            clearAll();
            a.play(); this._currentAudio = a; a._btnId = 'hp_' + aid; b.textContent = '⏸';
            if (wave) wave.classList.add('playing');
        } else { a.pause(); b.textContent = '▶'; if (wave) wave.classList.remove('playing'); this._currentAudio = null; }
    },
    selA(cid, aid) { Storage.setItemSelectedAudio(this.projectId, 'characters', cid, aid); App.showToast('已选择', 'success'); this.showAudioHistory(cid); this.render(this.projectId); },
    delA(cid, aid) {
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">确认删除</h2></div>
        <div class="modal-body"><p style="text-align:center;padding:1rem">确定要删除这条音频吗？</p></div>
        <div class="modal-footer"><button class="btn-secondary" onclick="CharacterModule.showAudioHistory('${cid}')">取消</button>
        <button class="btn-danger" onclick="CharacterModule.doDelA('${cid}','${aid}')">确认删除</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    doDelA(cid, aid) {
        Storage.deleteMediaItem(this.projectId, aid);
        App.showToast('已删除', 'success');
        this.showAudioHistory(cid);
        this.render(this.projectId);
    },

    initViewer() {
        if (document.getElementById('imgViewerOverlay')) return;
        const v = document.createElement('div');
        v.id = 'imgViewerOverlay';
        v.className = 'img-viewer-overlay';
        v.innerHTML = `<div class="img-viewer-close" onclick="CharacterModule.closeImageZoom()">×</div>
        <div class="img-viewer-info" id="imgViewerInfo"></div>
        <div class="img-viewer-toolbar">
            <button onclick="CharacterModule.viewerZoom(-0.3)">🔍-</button>
            <button onclick="CharacterModule.viewerZoom(0.3)">🔍+</button>
            <button onclick="CharacterModule.viewerReset()">↺ 重置</button>
        </div><div class="img-viewer-wrap" id="imgViewerWrap"></div>`;
        v.addEventListener('click', (e) => { if (e.target === v || e.target.id === 'imgViewerWrap') this.closeImageZoom(); });
        document.body.appendChild(v);
    },

    openImageZoom(src, name, dims) {
        this.initViewer();
        const ov = document.getElementById('imgViewerOverlay');
        const w = document.getElementById('imgViewerWrap');
        const info = document.getElementById('imgViewerInfo');
        w.innerHTML = `<img src="${src}" id="imgViewerImg" style="transform:translate(0px,0px) scale(1);cursor:grab">`;
        const imgEl = document.getElementById('imgViewerImg');

        // Init viewer state
        const state = { scale: 1, offX: 0, offY: 0, drag: false, lastX: 0, lastY: 0 };
        this._imageViewer = state;

        imgEl.onload = () => {
            // Fit image to 80% of viewport
            const maxW = window.innerWidth * 0.8;
            const maxH = window.innerHeight * 0.8;
            const fitScale = Math.min(maxW / imgEl.naturalWidth, maxH / imgEl.naturalHeight, 1);
            state.scale = fitScale;
            imgEl.style.transform = `translate(0px,0px) scale(${fitScale})`;
            info.textContent = `${name || ''} · ${imgEl.naturalWidth}x${imgEl.naturalHeight}`;
        };
        info.textContent = name ? `${name}${dims ? ' · ' + dims : ''}` : (dims || '');

        // Drag to pan
        const onMove = (e) => {
            if (!state.drag) return;
            state.offX += e.clientX - state.lastX;
            state.offY += e.clientY - state.lastY;
            state.lastX = e.clientX; state.lastY = e.clientY;
            imgEl.style.transform = `translate(${state.offX}px,${state.offY}px) scale(${state.scale})`;
        };
        const onUp = () => { state.drag = false; imgEl.style.cursor = 'grab'; };
        state._onMove = onMove; state._onUp = onUp;
        imgEl.onmousedown = (e) => { state.drag = true; state.lastX = e.clientX; state.lastY = e.clientY; imgEl.style.cursor = 'grabbing'; e.preventDefault(); };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        imgEl.ondragstart = () => false;

        ov.classList.add('active');
        document.addEventListener('keydown', this._onViewerKey);
        ov.onwheel = (e) => { e.preventDefault(); this.viewerZoom(e.deltaY > 0 ? -0.15 : 0.15); };
    },

    _onViewerKey(e) { if (e.key === 'Escape') CharacterModule.closeImageZoom(); },

    _applyViewerTransform() {
        const img = document.getElementById('imgViewerImg');
        const s = this._imageViewer;
        if (img && s) img.style.transform = `translate(${s.offX}px,${s.offY}px) scale(${s.scale})`;
    },

    viewerZoom(delta) {
        const s = this._imageViewer;
        if (!s) return;
        s.scale = Math.max(0.15, Math.min(8, s.scale + delta));
        this._applyViewerTransform();
    },

    viewerReset() {
        const img = document.getElementById('imgViewerImg');
        const s = this._imageViewer;
        if (!s || !img) return;
        s.scale = 1; s.offX = 0; s.offY = 0;
        this._applyViewerTransform();
    },

    closeImageZoom() {
        const ov = document.getElementById('imgViewerOverlay');
        if (ov) ov.classList.remove('active');
        document.removeEventListener('keydown', this._onViewerKey);
        // Clean up drag listeners
        const s = this._imageViewer;
        if (s) { window.removeEventListener('mousemove', s._onMove); window.removeEventListener('mouseup', s._onUp); }
        this._imageViewer = null;
    },

    getImgDims(imgData) {
        if (!imgData) return '';
        const m = imgData.match(/^data:image\/(\w+)/);
        const fmt = m ? m[1] : 'img';
        const len = imgData.length;
        const kb = Math.round((len * 0.75) / 1024);
        return `${fmt} · ${kb}KB`;
    },

    getImgPixelDims(imgObj) {
        if (imgObj && imgObj.width && imgObj.height) return `${imgObj.width}x${imgObj.height}`;
        return '';
    },

    // 统一的卡片生成遮罩（旋转光环 + 计时 + 进度条），三个模块共用
    genOverlayHtml(id, elapsedSec, barPct) {
        return `<div class="gen-card-overlay" id="genCard_${id}">
            <div class="gen-card-spinner"><span class="gen-card-timer" id="genCardTime_${id}">${elapsedSec}s</span></div>
            <div class="gen-card-label">生成中</div>
            <div class="gen-card-bar-wrap"><div class="gen-card-bar" id="genCardBar_${id}" style="width:${barPct}%"></div></div>
        </div>`;
    },

    // 列表缩略图下方的尺寸标签：有 width 直接显示 W×H，否则留空等待 onImgLoad 回填
    imgDimLabel(imgObj) {
        if (!imgObj) return '';
        if (imgObj.width && imgObj.height) return `${imgObj.width}×${imgObj.height}`;
        return '';
    },

    onImgLoad(el, fallback) {
        if (!el || !el.naturalWidth) return;
        const dims = `${el.naturalWidth}×${el.naturalHeight}`;
        // 找到同一图片区域旁的尺寸标签（兼容 list-row-img-section 容器结构）
        let label = el.parentElement ? el.parentElement.querySelector('.gen-img-label') : null;
        if (!label && el.closest) {
            const sec = el.closest('.list-row-img-section') || el.closest('.storyboard-card-img-section') || el.closest('.list-card');
            if (sec) label = sec.querySelector('.gen-img-label');
        }
        if (!label) return;
        // 已有真实尺寸（含 × 或 x）则不覆盖；占位/编号则回填
        const cur = (label.textContent || '').trim();
        if (/\d+\s*[×x]\s*\d+/.test(cur)) return;
        label.textContent = dims;
    },

    async computeDims(imgData) {
        return new Promise((resolve) => {
            const i = new Image();
            i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight });
            i.onerror = () => resolve({ w: 0, h: 0 });
            i.src = imgData;
        });
    },

    showAddCharacterModal() {
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">添加人物</h2><button class="modal-close" onclick="App.closeModal()">×</button></div><div class="modal-body"><div class="form-group"><label class="form-label">姓名</label><input class="form-input" id="cn"></div><div class="form-group"><label class="form-label">外貌</label><textarea class="form-textarea" id="ca" style="min-height:80px"></textarea></div><div class="form-group"><label class="form-label">音色</label><textarea class="form-textarea" id="cv" style="min-height:80px"></textarea></div></div><div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">取消</button><button class="btn-primary" onclick="CharacterModule.add()">添加</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    add() { const n = document.getElementById('cn').value.trim(), a = document.getElementById('ca').value.trim(), v = document.getElementById('cv').value.trim(); if (!n) { App.showToast('请输入姓名', 'error'); return; } Storage.addCharacter(this.projectId, { name: n, appearance: a, voice: v, source: 'manual' }); App.closeModal(); App.showToast('已添加', 'success'); this.render(this.projectId); },

    showEditCharacterModal(cid) {
        const p = Storage.getProject(this.projectId), c = p.characters && p.characters.find(x => x.id === cid); if (!c) return;
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">编辑</h2><button class="modal-close" onclick="App.closeModal()">×</button></div><div class="modal-body"><div class="form-group"><label class="form-label">姓名</label><input class="form-input" id="en" value="${this.esc(c.name)}"></div><div class="form-group"><label class="form-label">外貌</label><textarea class="form-textarea" id="ea" style="min-height:100px">${this.esc(c.appearance || c.description || '')}</textarea></div><div class="form-group"><label class="form-label">音色</label><textarea class="form-textarea" id="ev" style="min-height:80px">${this.esc(c.voice || '')}</textarea></div></div><div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">取消</button><button class="btn-primary" onclick="CharacterModule.upd('${cid}')">保存</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    upd(cid) { const n = document.getElementById('en').value.trim(), a = document.getElementById('ea').value.trim(), v = document.getElementById('ev').value.trim(); if (!n) { App.showToast('请输入姓名', 'error'); return; } Storage.updateCharacter(this.projectId, cid, { name: n, appearance: a, voice: v }); App.closeModal(); App.showToast('已更新', 'success'); this.render(this.projectId); },

    del(cid) {
        const p = Storage.getProject(this.projectId), c = p.characters && p.characters.find(x => x.id === cid);
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">确认删除</h2><button class="modal-close" onclick="App.closeModal()">×</button></div><div class="modal-body"><p style="text-align:center">删除「${this.esc(c ? c.name : '')}」？</p></div><div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">取消</button><button class="btn-danger" id="cdb">确认删除</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
        const s = this; document.getElementById('cdb').onclick = function () { this.disabled = true; Storage.deleteCharacter(s.projectId, cid); App.closeModal(); App.showToast('已删除', 'success'); s.render(s.projectId); };
    },

    async generateImage(cid) {
        const p = Storage.getProject(this.projectId), c = p.characters.find(x => x.id === cid); if (!c) return;
        const s = Storage.getSettings();
        const groups = s.imageApiGroups || [];
        const defs = s.imageDefaults || {};
        if (!groups.length) { App.showToast('请先在设置中配置图像API', 'error'); return; }

        const activeGroup = groups.find(g => g.id === (defs.activeGroupId || groups[0].id)) || groups[0];
        const models = activeGroup.models || ['dall-e-3'];
        const defaultPrompt = c.appearance || c.description || c.name;

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">生成图像 - ${this.esc(c.name)}</h2></div>
        <div class="modal-body">
            <div class="form-group"><label class="form-label">提示词</label><textarea class="form-textarea" id="genPrompt" style="min-height:100px">${this.esc(defaultPrompt)}</textarea></div>
            <div class="form-row">
                <div class="form-col"><label class="form-label">API分组</label><select class="form-input" id="genGroup" onchange="CharacterModule.onGroupChange()">${groups.map(g=>`<option value="${g.id}" ${g.id===activeGroup.id?'selected':''}>${this.esc(g.name)}</option>`).join('')}</select></div>
                <div class="form-col"><label class="form-label">模型</label><select class="form-input" id="genModel">${models.map(m=>`<option value="${m}" ${m===(defs.model||models[0])?'selected':''}>${m}</option>`).join('')}</select></div>
            </div>
            <div class="form-row">
                <div class="form-col"><label class="form-label">画质</label><select class="form-input" id="genQual">${this.selOpts(['auto','low','medium','high'],defs.quality||'auto')}</select></div>
                <div class="form-col"><label class="form-label">图像尺寸</label><select class="form-input" id="genSize">${this.sizeOpts(defs.size||'auto')}</select></div>
            </div>
            <div id="genResult" style="margin-top:0.75rem"></div>
        </div>
        <div class="modal-footer"><button class="btn-secondary" id="genCloseBtn" onclick="App.closeModal()">关闭</button><button class="btn-primary" id="genBtn" onclick="CharacterModule.doGenImg('${cid}')">▶ 生成</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
        this._genGroups = groups;
    },

    onGroupChange() {
        const gid = document.getElementById('genGroup').value;
        const group = (this._genGroups || []).find(g => g.id === gid);
        const sel = document.getElementById('genModel');
        sel.innerHTML = (group && group.models ? group.models : ['dall-e-3']).map(m => `<option value="${m}">${m}</option>`).join('');
    },

    renderRowUpdate(cid) {
        const task = this._genTasks[cid];
        if (!task) { delete this._genTimers[cid]; return; }
        const overlay = document.getElementById('genCard_' + cid);
        const timer = document.getElementById('genCardTime_' + cid);
        const bar = document.getElementById('genCardBar_' + cid);
        if (!overlay) { delete this._genTimers[cid]; return; }
        const elapsed = Math.round((Date.now() - task) / 1000);
        if (timer) timer.textContent = elapsed + 's';
        if (bar) {
            const pct = Math.min(elapsed * 3, 90);
            bar.style.width = pct + '%';
        }
        this._genTimers[cid] = setTimeout(() => this.renderRowUpdate(cid), 1000);
    },

    ttsRowUpdate(cid) {
        const task = this._ttsTasks[cid];
        if (!task) { delete this._ttsTimers[cid]; return; }
        const el = document.getElementById('ttsTime_' + cid);
        if (!el) { delete this._ttsTimers[cid]; return; }
        const elapsed = Math.round((Date.now() - task) / 1000);
        el.textContent = '⏳ ' + elapsed + 's';
        this._ttsTimers[cid] = setTimeout(() => this.ttsRowUpdate(cid), 1000);
    },

    async doGenImg(cid) {
        const p = Storage.getProject(this.projectId), c = p.characters.find(x => x.id === cid); if (!c) return;
        const prompt = document.getElementById('genPrompt').value.trim();
        if (!prompt) { App.showToast('请输入提示词', 'error'); return; }

        // 将修改后的提示词保存回人物外貌描述，使外部列表同步更新
        c.appearance = prompt;
        Storage.updateProject(this.projectId, { characters: p.characters });

        const gid = document.getElementById('genGroup').value;
        const groups = Storage.getSettings().imageApiGroups || [];
        const group = groups.find(g => g.id === gid) || groups[0];
        if (!group || !group.apiKey) { App.showToast('API Key 未配置', 'error'); return; }

        const ctx = {
            id: cid, module: 'characters', projectId: this.projectId, prompt,
            apiUrl: group.url, apiKey: group.apiKey,
            model: document.getElementById('genModel').value,
            size: document.getElementById('genSize').value,
            quality: document.getElementById('genQual').value,
        };
        await this._submitGenJob(ctx, () => this.render(this.projectId));
    },

    // 通用：提交图像任务 + 在弹窗内展示进度（关闭弹窗/刷新都不影响后台任务）
    async _submitGenJob(ctx, rerender) {
        const id = ctx.id;
        const genBtn = document.getElementById('genBtn');
        const closeBtn = document.getElementById('genCloseBtn');
        const resultDiv = document.getElementById('genResult');
        if (genBtn) { genBtn.disabled = true; genBtn.classList.add('btn-disabled'); genBtn.textContent = '⏳ 提交中…'; }
        if (closeBtn) closeBtn.disabled = false;
        if (resultDiv) resultDiv.innerHTML = `<div class="gen-progress"><div class="gen-progress-bar" id="genBar" style="width:8%"></div></div><p class="gen-progress-tip">已提交到后台生成，可关闭此窗口，进度会显示在卡片上；即使刷新页面也不会丢失。</p>`;

        const res = await this._startImageJob(ctx);
        if (rerender) rerender();
        setTimeout(() => this.renderRowUpdate(id), 50);

        if (!res.ok) {
            if (genBtn) { genBtn.disabled = false; genBtn.classList.remove('btn-disabled'); genBtn.textContent = '▶ 重试'; }
            if (resultDiv) resultDiv.innerHTML = `<div class="gen-error-box">❌ ${this.esc(res.error || '提交失败')}</div>`;
            return;
        }

        // 弹窗仍开着时，结果回来后更新弹窗内容
        this._genUICallbacks[id] = (r) => {
            const gb = document.getElementById('genBtn');
            const rd = document.getElementById('genResult');
            if (r.ok) {
                if (gb) { gb.textContent = '✅ 完成'; gb.classList.remove('btn-disabled'); gb.disabled = false; gb.onclick = function () { App.closeModal(); }; }
                if (rd) rd.innerHTML = `<div class="gen-progress"><div class="gen-progress-bar" style="width:100%;background:var(--ok)"></div></div><p style="color:var(--ok);font-weight:600;text-align:center;margin:0.5rem 0">✅ 图像已生成</p><img src="${r.imgData}" style="width:100%;border-radius:8px">`;
            } else {
                if (gb) { gb.textContent = '▶ 重试'; gb.classList.remove('btn-disabled'); gb.disabled = false; }
                if (rd) rd.innerHTML = `<div class="gen-error-box">❌ ${this.esc(r.error || '生成失败')}</div>`;
            }
        };
        if (genBtn) genBtn.textContent = '⏳ 生成中…';
    },
    uploadImage(cid) { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.onchange = async e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = async ev => { const d = ev.target.result; const dims = await CharacterModule.computeDims(d); await Storage.addCharacterImage(CharacterModule.projectId, cid, d, dims); App.showToast('已上传', 'success'); this.render(this.projectId); }; r.readAsDataURL(f); }; inp.click(); },

    // ===== 通用拖拽上传（人物 / 道具 / 场景图像卡片共用）=====
    // 在 App.init 时调用一次：document 级事件委托，对 tabContent 内所有
    // .list-row-img-section[data-drop-id] 生效；重渲染后依旧有效（无需重新绑定）。
    initDropUpload() {
        if (this._dropBound) return;
        this._dropBound = true;
        const zoneOf = (e) => e.target && e.target.closest && e.target.closest('.list-row-img-section[data-drop-id]');
        const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
        document.addEventListener('dragover', (e) => {
            const zone = zoneOf(e);
            if (!zone || !hasFiles(e)) return;
            e.preventDefault();
            if (this._dropZone && this._dropZone !== zone) this._dropZone.classList.remove('drop-over');
            this._dropZone = zone;
            zone.classList.add('drop-over');
        });
        document.addEventListener('dragleave', (e) => {
            const zone = zoneOf(e);
            // 真正离开当前高亮区（移到区外）才取消高亮
            if (zone && zone === this._dropZone && !zone.contains(e.relatedTarget)) {
                zone.classList.remove('drop-over');
                this._dropZone = null;
            }
        });
        document.addEventListener('drop', (e) => {
            const zone = zoneOf(e);
            if (!zone || !hasFiles(e)) return;
            e.preventDefault();
            zone.classList.remove('drop-over');
            this._dropZone = null;
            const file = e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) return;
            if (!/^image\//.test(file.type)) { App.showToast('⚠️ 请拖入图片文件', 'error'); return; }
            this._dropUpload(file, zone.dataset.dropKind, zone.dataset.dropId, zone.dataset.dropType);
        });
    },

    // 把拖入的图片文件存为对应素材的图像（char → 人物；item → 道具/场景）
    _dropUpload(file, kind, id, type) {
        const r = new FileReader();
        r.onload = async (ev) => {
            try {
                const d = ev.target.result;
                const dims = await CharacterModule.computeDims(d);
                if (kind === 'item') {
                    await Storage.addItemImage(PropsScenesModule.projectId, type, id, d, dims);
                    App.showToast('已上传', 'success');
                    PropsScenesModule.render(PropsScenesModule.projectId, type);
                } else {
                    await Storage.addCharacterImage(CharacterModule.projectId, id, d, dims);
                    App.showToast('已上传', 'success');
                    CharacterModule.render(CharacterModule.projectId);
                }
            } catch (err) {
                App.showToast('❌ 上传失败：' + (err.message || '未知错误'), 'error');
            }
        };
        r.onerror = () => App.showToast('❌ 图片读取失败', 'error');
        r.readAsDataURL(file);
    },

    showHistoryModal(cid) {
        const p = Storage.getProject(this.projectId), c = p.characters.find(x => x.id === cid); if (!c) return;
        const images = Storage.getMediaForItem(this.projectId, 'characters', cid).filter(m => m.type === 'image');
        const mc = document.getElementById('modalContent');
        const galleryHtml = images.map(m => {
            const dim = this.mediaDimLabel(m);
            const isCur = m.id === c.selectedImage;
            return `<div class="gallery-item ${isCur ? 'selected' : ''}">
                ${isCur ? '<div class="gallery-current-badge">✓ 当前使用</div>' : ''}
                <div class="gallery-img-wrap">
                    <img src="${Storage.mediaUrl(m.data)}" loading="lazy" onload="CharacterModule.fillGalleryDim(this)" onclick="CharacterModule.openImageZoom('${Storage.mediaUrl(m.data)}','${this.esc(c.name)}','${dim}')">
                    <div class="gallery-zoom-hint">🔍 点击放大</div>
                </div>
                <div class="gallery-item-actions">
                    <button class="gallery-select-btn" title="设为当前" onclick="CharacterModule.selI('${cid}','${m.id}')">✓</button>
                    <button class="gallery-delete-btn" title="删除" onclick="CharacterModule.delI('${cid}','${m.id}')">×</button>
                </div>
                <div class="gallery-dim-label">${dim}</div>
            </div>`;
        }).join('');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">📷 图像历史 · ${this.esc(c.name)}</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
        <div class="modal-body">${images.length ? `<div class="gallery-count">共 ${images.length} 张图像</div><div class="image-gallery">${galleryHtml}</div>` : `<div class="empty-state"><div class="empty-state-icon">📷</div><div class="empty-state-text">暂无图像，去生成或上传吧</div></div>`}</div>
        <div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">关闭</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    selI(cid, iid) { Storage.setCharacterCurrentImage(this.projectId, cid, iid); App.showToast('已选择', 'success'); this.showHistoryModal(cid); this.render(this.projectId); },
    delI(cid, iid) {
        // 使用应用内确认弹窗，避免浏览器 confirm() 的事件穿透问题
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">确认删除</h2></div>
        <div class="modal-body"><p style="text-align:center;padding:1rem">确定要删除这张图像吗？此操作不可撤销。</p></div>
        <div class="modal-footer"><button class="btn-secondary" onclick="CharacterModule.showHistoryModal('${cid}')">取消</button>
        <button class="btn-danger" onclick="CharacterModule.doDelI('${cid}','${iid}')">确认删除</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    doDelI(cid, iid) {
        Storage.deleteMediaItem(this.projectId, iid);
        App.showToast('已删除', 'success');
        this.showHistoryModal(cid);
        this.render(this.projectId);
    },

    esc(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; },
    // 媒体对象 -> 尺寸标签（优先真实像素尺寸，否则回退到编号）
    mediaDimLabel(m) {
        if (m && m.width && m.height) return `${m.width} × ${m.height}`;
        return m ? `#${m.id}` : '';
    },

    // 画廊图片加载完成后，用自然尺寸回填标签（兼容缺少 width/height 的旧图）
    fillGalleryDim(imgEl) {
        if (!imgEl || !imgEl.naturalWidth) return;
        const item = imgEl.closest('.gallery-item');
        const label = item ? item.querySelector('.gallery-dim-label') : null;
        if (!label) return;
        // 仅在当前显示的是占位编号（#开头）或为空时才回填，避免覆盖已存的真实尺寸
        const txt = (label.textContent || '').trim();
        if (txt && !txt.startsWith('#')) return;
        label.textContent = `${imgEl.naturalWidth} × ${imgEl.naturalHeight}`;
    },
    selOpts(arr, sel) { return arr.map(v => `<option value="${v}" ${v===sel?'selected':''}>${v}</option>`).join(''); },
    sizeOpts(sel) {
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
    }
};
