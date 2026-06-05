const PropsScenesModule = {
    projectId: null, type: null,
    render(pid, t) {
        this.projectId = pid; this.type = t; CharacterModule._restoreTaskState();
        const p = Storage.getProject(pid), items = p[t] || [], title = t === 'props' ? '道具' : '场景';
        const rows = items.map((i, idx) => this.renderRow(i, idx, t)).join('');
        document.getElementById('tabContent').innerHTML = `<div class="list-container">${rows || `<div class="empty-state"><div class="empty-state-icon">${t === 'props' ? '🔧' : '🏞️'}</div><div class="empty-state-text">暂无${title}</div></div>`}<div class="list-add-bar" onclick="PropsScenesModule.showAdd()"><span>+ 添加${title}</span></div></div>`;

        // 切换tab回来后恢复进度条更新
        Object.keys(CharacterModule._genTasks).forEach(cid => {
            if (CharacterModule._genTimers[cid]) clearTimeout(CharacterModule._genTimers[cid]);
            CharacterModule.renderRowUpdate(cid);
        });
    },
    renderRow(i, idx, t) {
        const img = Storage.getSelectedMedia(this.projectId, t, i, 'image');
        const srcTag = i.source === 'cc' ? 'cc' : 'man';
        const pd = CharacterModule.imgDimLabel(img);
        const genTask = CharacterModule._genTasks[i.id];
        const elapsedSec = genTask ? Math.round((Date.now() - genTask) / 1000) : 0;
        const barPct = genTask ? Math.min(elapsedSec * 3, 90) : 0;
        const genOverlay = genTask ? CharacterModule.genOverlayHtml(i.id, elapsedSec, barPct) : '';
        return `<div class="list-row">
            <div class="list-row-img-section" data-drop-kind="item" data-drop-id="${i.id}" data-drop-type="${t}">
                <div class="list-row-img" onclick="CharacterModule.openImageZoom('${img ? Storage.mediaUrl(img.data) : ''}','${this.esc(i.name)}','${pd}')" style="position:relative">
                    ${img ? `<img src="${Storage.mediaUrl(img.data)}" alt="" onload="CharacterModule.onImgLoad(this,'${pd}')">` : `<div class="placeholder-lg">${t === 'props' ? '🔧' : '🏞️'}</div>`}
                    ${genOverlay}
                    <div class="drop-add-overlay"><span class="drop-add-plus">＋</span><span class="drop-add-text">松开上传图片</span></div>
                </div>
                ${img ? `<span class="gen-img-label">${pd}</span>` : ''}
                <div class="list-img-btns">
                    <button class="btn-ghost btn-tiny ${genTask ? 'btn-disabled' : ''}" id="genCardBtn_${i.id}" onclick="${genTask ? '' : `PropsScenesModule.genImg('${i.id}')`}">${genTask ? '⏳ 生成' : '🎨 生成'}</button>
                    <button class="btn-ghost btn-tiny" onclick="PropsScenesModule.upload('${i.id}')">📁 上传</button>
                    <button class="btn-ghost btn-tiny" onclick="PropsScenesModule.showHist('${i.id}')">📷 历史</button>
                </div>
                ${(!genTask && i.lastGenError) ? CharacterModule.genErrorTag(i.lastGenError) : ''}
            </div>
            <div class="list-row-body">
                <div class="list-row-header">
                    <span class="list-row-no">${idx + 1}.</span>
                    ${InlineEdit.field(i.name, { single: true, placeholder: '未命名',
                        className: 'list-row-name-edit',
                        data: { edit: 'item', type: t, id: i.id, field: 'name' } })}
                    <span class="tag-${srcTag}">${i.source === 'cc' ? '🤖 CC' : '✍️ 手动'}</span>
                </div>
                <div class="list-row-top-right">
                    <button class="btn-ghost btn-ghost-danger btn-tiny" onclick="PropsScenesModule.del('${i.id}')">🗑️ 删除</button>
                </div>
                <div class="list-row-meta">
                    <div class="meta-section">
                        <div class="meta-header">
                            <span class="meta-label">描述</span>
                        </div>
                        ${InlineEdit.field(i.description || '', {
                            placeholder: `点击填写${t === 'props' ? '道具' : '场景'}描述…`,
                            className: 'meta-content',
                            data: { edit: 'item', type: t, id: i.id, field: 'description' } })}
                    </div>
                </div>
            </div>
        </div>`;
    },
    showAdd() {
        const t = this.type === 'props' ? '道具' : '场景', mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">添加${t}</h2><button class="modal-close" onclick="App.closeModal()">×</button></div><div class="modal-body"><div class="form-group"><label class="form-label">名称</label><input class="form-input" id="in"></div><div class="form-group"><label class="form-label">描述</label><textarea class="form-textarea" id="id" style="min-height:100px"></textarea></div></div><div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">取消</button><button class="btn-primary" onclick="PropsScenesModule.add()">添加</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    add() { const n = document.getElementById('in').value.trim(), d = document.getElementById('id').value.trim(); if (!n) { App.showToast('请输入名称', 'error'); return; } Storage.addItem(this.projectId, this.type, { name: n, description: d, source: 'manual' }); App.closeModal(); App.showToast('已添加', 'success'); this.render(this.projectId, this.type); },
    showEdit(iid) { const p = Storage.getProject(this.projectId), items = p[this.type] || [], i = items.find(x => x.id === iid); if (!i) return; const t = this.type === 'props' ? '道具' : '场景', mc = document.getElementById('modalContent'); mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">编辑${t}</h2><button class="modal-close" onclick="App.closeModal()">×</button></div><div class="modal-body"><div class="form-group"><label class="form-label">名称</label><input class="form-input" id="en" value="${this.esc(i.name)}"></div><div class="form-group"><label class="form-label">描述</label><textarea class="form-textarea" id="ed" style="min-height:120px">${this.esc(i.description || '')}</textarea></div></div><div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">取消</button><button class="btn-primary" onclick="PropsScenesModule.upd('${iid}')">保存</button></div>`; document.getElementById('modalOverlay').classList.add('active'); },
    upd(iid) { const n = document.getElementById('en').value.trim(), d = document.getElementById('ed').value.trim(); if (!n) { App.showToast('请输入名称', 'error'); return; } Storage.updateItem(this.projectId, this.type, iid, { name: n, description: d }); App.closeModal(); App.showToast('已更新', 'success'); this.render(this.projectId, this.type); },
    del(iid) { const p = Storage.getProject(this.projectId), items = p[this.type] || [], i = items.find(x => x.id === iid), mc = document.getElementById('modalContent'); mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">确认删除</h2><button class="modal-close" onclick="App.closeModal()">×</button></div><div class="modal-body"><p style="text-align:center">删除「${this.esc(i ? i.name : '')}」？</p></div><div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">取消</button><button class="btn-danger" id="cdb">确认删除</button></div>`; document.getElementById('modalOverlay').classList.add('active'); const s = this; document.getElementById('cdb').onclick = function () { this.disabled = true; Storage.deleteItem(s.projectId, s.type, iid); App.closeModal(); App.showToast('已删除', 'success'); s.render(s.projectId, s.type); }; },
    async genImg(iid) {
        const p = Storage.getProject(this.projectId), items = p[this.type] || [], item = items.find(x => x.id === iid);
        if (!item) return;
        const s = Storage.getSettings();
        const groups = s.imageApiGroups || [];
        const defs = s.imageDefaults || {};
        if (!groups.length) { App.showToast('请先在设置中配置图像API', 'error'); return; }
        const activeGroup = groups.find(g => g.id === (defs.activeGroupId || groups[0].id)) || groups[0];
        const models = activeGroup.models || ['dall-e-3'];

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">生成图像 - ${this.esc(item.name)}</h2></div>
        <div class="modal-body">
            <div class="form-group"><label class="form-label">提示词</label><textarea class="form-textarea" id="genPrompt" style="min-height:100px">${this.esc(item.description || item.name)}</textarea></div>
            <div class="form-row">
                <div class="form-col"><label class="form-label">API分组</label><select class="form-input" id="genGroup" onchange="PropsScenesModule.onGroupChange()">${groups.map(g=>`<option value="${g.id}" ${g.id===activeGroup.id?'selected':''}>${this.esc(g.name)}</option>`).join('')}</select></div>
                <div class="form-col"><label class="form-label">模型</label><select class="form-input" id="genModel">${models.map(m=>`<option value="${m}" ${m===(defs.model||models[0])?'selected':''}>${m}</option>`).join('')}</select></div>
            </div>
            <div class="form-row">
                <div class="form-col"><label class="form-label">画质</label><select class="form-input" id="genQual">${['auto','low','medium','high'].map(v=>`<option value="${v}" ${v===(defs.quality||'auto')?'selected':''}>${v}</option>`).join('')}</select></div>
                <div class="form-col"><label class="form-label">图像尺寸</label><select class="form-input" id="genSize">${[{v:'auto',l:'auto 默认'},{v:'1024x1024',l:'1024x1024 正方形 1:1'},{v:'1536x1024',l:'1536x1024 横屏 3:2'},{v:'1024x1536',l:'1024x1536 竖屏 2:3'},{v:'2048x2048',l:'2048x2048 2K正方形 1:1'},{v:'2048x1152',l:'2048x1152 2K横屏 16:9'},{v:'3840x2160',l:'3840x2160 4K横屏 16:9'},{v:'2160x3840',l:'2160x3840 4K竖屏 9:16'}].map(s=>`<option value="${s.v}" ${s.v===(defs.size||'auto')?'selected':''}>${s.l}</option>`).join('')}</select></div>
            </div>
            <div id="genResult" style="margin-top:0.75rem"></div>
        </div>
        <div class="modal-footer"><button class="btn-secondary" id="genCloseBtn" onclick="App.closeModal()">关闭</button><button class="btn-primary" id="genBtn" onclick="PropsScenesModule.doGenImg('${iid}')">▶ 生成</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
        this._genGroups = groups;
    },

    async doGenImg(iid) {
        const p = Storage.getProject(this.projectId), items = p[this.type] || [], item = items.find(x => x.id === iid);
        if (!item) return;
        const prompt = document.getElementById('genPrompt').value.trim();
        if (!prompt) { App.showToast('请输入提示词', 'error'); return; }

        // 将修改后的提示词保存回描述字段，使外部列表同步更新
        item.description = prompt;
        Storage.updateProject(this.projectId, { [this.type]: items });

        const gid = document.getElementById('genGroup').value;
        const groups = Storage.getSettings().imageApiGroups || [];
        const group = groups.find(g => g.id === gid) || groups[0];
        if (!group || !group.apiKey) { App.showToast('API Key 未配置', 'error'); return; }

        const ctx = {
            id: iid, module: this.type, projectId: this.projectId, prompt,
            apiUrl: group.url, apiKey: group.apiKey,
            model: document.getElementById('genModel').value,
            size: document.getElementById('genSize').value,
            quality: document.getElementById('genQual').value,
        };
        await CharacterModule._submitGenJob(ctx, () => this.render(this.projectId, this.type));
    },
    upload(iid) { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.onchange = async e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = async ev => { const d = ev.target.result; const dims = await CharacterModule.computeDims(d); await Storage.addItemImage(this.projectId, this.type, iid, d, dims); App.showToast('已上传', 'success'); this.render(this.projectId, this.type); }; r.readAsDataURL(f); }; inp.click(); },
    showHist(iid) {
        const p = Storage.getProject(this.projectId), items = p[this.type] || [], i = items.find(x => x.id === iid);
        if (!i) return;
        // 图片存储在中央 mediaLibrary，与列表/删除/选择逻辑保持一致（含真实尺寸）
        const imgs = Storage.getMediaForItem(this.projectId, this.type, iid).filter(m => m.type === 'image');
        const galleryHtml = imgs.map(img => {
            const dim = CharacterModule.mediaDimLabel(img);
            const isCur = img.id === i.selectedImage;
            return `<div class="gallery-item ${isCur ? 'selected' : ''}">
                ${isCur ? '<div class="gallery-current-badge">✓ 当前使用</div>' : ''}
                <div class="gallery-img-wrap">
                    <img src="${Storage.mediaUrl(img.data)}" loading="lazy" onload="CharacterModule.fillGalleryDim(this)" onclick="CharacterModule.openImageZoom('${Storage.mediaUrl(img.data)}','${this.esc(i.name)}','${dim}')">
                    <div class="gallery-zoom-hint">🔍 点击放大</div>
                </div>
                <div class="gallery-item-actions">
                    <button class="gallery-select-btn" title="设为当前" onclick="PropsScenesModule.selI('${iid}','${img.id}')">✓</button>
                    <button class="gallery-delete-btn" title="删除" onclick="PropsScenesModule.delI('${iid}','${img.id}')">×</button>
                </div>
                <div class="gallery-dim-label">${dim}</div>
            </div>`;
        }).join('');
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">📷 图像历史 · ${this.esc(i.name)}</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
        <div class="modal-body">${imgs.length ? `<div class="gallery-count">共 ${imgs.length} 张图像</div><div class="image-gallery">${galleryHtml}</div>` : `<div class="empty-state"><div class="empty-state-icon">📷</div><div class="empty-state-text">暂无图像，去生成或上传吧</div></div>`}</div>
        <div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">关闭</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    selI(iid, imgid) { Storage.setItemCurrentImage(this.projectId, this.type, iid, imgid); App.showToast('已选择', 'success'); this.showHist(iid); this.render(this.projectId, this.type); },
    delI(iid, imgid) {
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">确认删除</h2></div>
        <div class="modal-body"><p style="text-align:center;padding:1rem">确定要删除这张图像吗？</p></div>
        <div class="modal-footer"><button class="btn-secondary" onclick="PropsScenesModule.showHist('${iid}')">取消</button>
        <button class="btn-danger" onclick="PropsScenesModule.doDelI('${iid}','${imgid}')">确认删除</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    doDelI(iid, imgid) {
        Storage.deleteMediaItem(this.projectId, imgid);
        App.showToast('已删除', 'success');
        this.showHist(iid);
        this.render(this.projectId, this.type);
    },

    onGroupChange() {
        const gid = document.getElementById('genGroup').value;
        const group = (this._genGroups || []).find(g => g.id === gid);
        const sel = document.getElementById('genModel');
        sel.innerHTML = (group && group.models ? group.models : ['dall-e-3']).map(m => `<option value="${m}">${m}</option>`).join('');
    },

    esc(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }
};
