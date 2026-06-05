// ============================================================================
// 分镜模块（LTX 2.3 四宫格工作流）
// 流程：① 调用 CC 生成分镜 JSON（四宫格/单分镜/全局提示词 + 台词人物映射）
//      ② gpt-image-2 编辑接口生成四宫格图（传入人物/道具/场景参考图）
//      ③ 四宫格前端 canvas 2x2 切分为 4 张
//      ④ Qwen3 语音克隆为每句台词配音（参考音色取自台词归属人物的已有音频）
//      ⑤ 选多个四宫格 → 时间轴弹窗（上图下音频，右侧 global/local，可播放/拉伸/换位）
//      ⑥ 调用 LTX2.3 导演台工作流生成视频（按转场调 Epsilon）
// 数据存储在 project.storyboardGroups。所有耗时操作走后端异步任务（刷新不丢）。
// ============================================================================
const StoryboardModule = {
    projectId: null,
    _polls: {},          // 内存中的四宫格轮询标记（fg_<gid> → taskId），仅用于 UI spinner
    _genGroups: null,    // 生成弹窗用的分组列表缓存
    _nanoOpen: {},       // gid → bool：四宫格图像提示词是否展开
    _fgTimers: {},       // gid → 计时器 interval（四宫格生成 s 数显示）
    _fgStart: {},        // gid → 开始时间戳
    _audioTasks: {},     // 'gid:panel' → 开始时间戳（面板配音进行中）
    _SB_TASK_KEY: 'assest_sb_gen_task',   // localStorage：进行中的 CC 分镜生成任务
    _SB_RESULT_KEY: 'assest_sb_gen_result', // localStorage：上次分镜生成结果横幅（常驻，手动关或下次覆盖）
    _FG_TASK_KEY: 'assest_sb_fg_tasks',   // localStorage：进行中的四宫格生成任务（刷新可恢复）

    // 转场 → Epsilon 映射（依据 WhatDreamsCost LTXDirector 节点源码：
    // <0.1 都是硬边界，paper 默认 0.001；越大过渡越柔和）
    TRANSITION_EPSILON: { cut: 0.001, smooth: 0.5, fade: 0.8 },
    FPS: 30,

    // ---------- 入口渲染 ----------
    render(projectId) {
        this.projectId = projectId;
        CharacterModule._restoreTaskState();
        const p = Storage.getProject(projectId);
        const groups = p.storyboardGroups || [];

        const insertBar = (afterId) => `<div class="sb-insert-bar"><button class="sb-insert-btn" title="在此处插入一个自定义单分镜（单图 + 单音频）" onclick="StoryboardModule.insertSingle('${afterId}')">＋ 插入单分镜</button></div>`;
        let rows = '';
        if (groups.length) {
            rows += insertBar('');  // 开头
            groups.forEach((g, i) => {
                rows += g.single ? this.renderSingleCard(g, i) : this.renderGroupCard(g, i);
                rows += insertBar(g.id);  // 每个组之后
            });
        }
        const body = `<div class="list-container">${rows || '<div class="empty-state"><div class="empty-state-icon">🎬</div><div class="empty-state-text">还没有分镜。点击「智能生成分镜」让 Claude 阅读剧本并自动拆分四宫格分镜。</div></div>'}</div>`;

        // 生成任务进行中：按钮置灰 + 转圈 + 显示已用秒数（任务在后台跑，刷新/切 tab 仍保持）
        const genTask = this._loadGenTask();
        const genElapsed = genTask ? Math.round((Date.now() - (genTask.start || Date.now())) / 1000) : 0;
        const genBtnHtml = genTask
            ? `<button class="btn-primary btn-disabled" id="sbGenMainBtn" disabled><span class="sb-spinner sb-spinner-inline"></span><span id="sbGenMainTimer">智能生成分镜中 ${genElapsed}s</span></button>
               <button class="btn-secondary sb-stop-btn" onclick="StoryboardModule.stopGenerate()" title="停止跟踪本次生成（后台任务可能仍在运行，但前端不再等待）">⏹ 停止</button>`
            : `<button class="btn-primary" id="sbGenMainBtn" onclick="StoryboardModule.startGenerate()">✨ 智能生成分镜</button>`;

        document.getElementById('tabContent').innerHTML = `
            <div class="sb-toolbar">
                <div class="sb-toolbar-left">
                    ${genBtnHtml}
                    <button class="btn-secondary" onclick="StoryboardModule.importGroupsFromFile()" title="上传分镜 JSON（含 person / 分镜 字段，与智能生成的格式一致），也可直接把 .json 拖到下方区域">📥 上传 JSON</button>
                    <input type="file" id="sbImportJson" accept="application/json,.json" style="display:none" onchange="StoryboardModule.onImportJsonFile(event)">
                    <button class="btn-secondary" onclick="StoryboardModule.exportContextJson()" title="导出剧本 / 人物 / 道具 / 场景为 JSON，供另一台机器导入或生成分镜复用">📤 导出素材</button>
                    <button class="btn-secondary" onclick="StoryboardModule.openTimeline()" ${groups.length ? '' : 'disabled'}>🎞️ 合成视频（时间轴）</button>
                    <button class="btn-secondary sb-mark-global" onclick="StoryboardModule.markAllSelectedGlobal()" ${groups.length ? '' : 'disabled'} title="把所有组中当前『已勾选合成』的分镜一键标记为已处理（置灰并取消勾选）">✅ 标记已选</button>
                </div>
                <div class="sb-toolbar-right">
                    <span class="sb-count">${groups.length} 组四宫格 · ${groups.length * 4} 个分镜</span>
                </div>
            </div>
            <div id="sbGenBanner">${this._genResultBannerHtml()}</div>
            <div id="sbDropZone" class="sb-drop-zone" title="可将分镜 JSON 文件拖到此处自动解析导入">
                <div class="sb-drop-hint">📥 将分镜 JSON 拖到此处即可自动解析导入</div>
                ${body}
            </div>
        `;
        this._bindDropZone();
        // 恢复进行中的 CC 分镜生成任务（刷新/切 tab 不丢）
        this._resumeGenTask();
        // 恢复进行中的四宫格轮询 UI
        this._resumePolls();
    },

    // ---------- 四宫格组卡片（列表行）----------
    renderGroupCard(g, idx) {
        const fourImg = g.fourGridImageId ? Storage.getMediaById(this.projectId, g.fourGridImageId) : null;
        const fourUrl = fourImg ? Storage.mediaUrl(fourImg.data) : '';
        const genning = !!this._polls['fg_' + g.id];
        const elapsed = this._fgStart[g.id] ? Math.round((Date.now() - this._fgStart[g.id]) / 1000) : 0;

        // 失败信息：不占位空图，仅在占位区/下方小字提示，下次生成自动清除
        const errMsg = g.fourGridError || '';
        const placeholder = genning
            ? `<div class="sb-spinner"></div><span id="fgTimer_${g.id}">生成中 ${elapsed}s</span>`
            : (errMsg ? '<span style="font-size:1.6rem">⚠️</span><span>生成失败</span>' : '🎬 待生成四宫格');

        // 素材就绪检查
        const ref = this._checkRefStatus(g);
        const refRow = (ref.missingImg.length || ref.missingAudio.length)
            ? `<div class="sb-ref-warn" title="生成四宫格用人物/道具/场景的『当前选中图』，配音用人物『当前选中音频』；在素材页更换后这里会自动跟随。">
                 ${ref.missingImg.length ? `⚠️ 缺参考图：${this.esc(ref.missingImg.join('、'))}` : ''}
                 ${ref.missingImg.length && ref.missingAudio.length ? '；' : ''}
                 ${ref.missingAudio.length ? `🔇 缺音色：${this.esc(ref.missingAudio.join('、'))}` : ''}
               </div>`
            : `<div class="sb-ref-ok" title="生成时自动使用素材页当前选中的图/音，更换后自动跟随">✅ 参考素材就绪（图 ${ref.imgCount} · 音色 ${ref.audioCount}）</div>`;

        const audioCount = (g.panelAudios || []).filter(Boolean).length;
        const lineCount = (g.dialogues || []).filter(d => d && d.text && d.text.trim()).length;
        const fgHistCount = Storage.getMediaForItem(this.projectId, 'storyboards', g.id).filter(m => m.type === 'image').length;
        // 一键全选/全标记：判断当前是否已全选/全标记（用于切换文案与行为）
        const allSelected = [0, 1, 2, 3].every(i => !(g.panelSelected && g.panelSelected[i] === false));
        const allMarked = [0, 1, 2, 3].every(i => !!(g.panelMarked && g.panelMarked[i]));

        // 四宫格图像提示词（nano）：过长收缩，可展开；可就地编辑（失焦自动保存）
        const nano = g.nanoPrompt || '';
        const nanoOpen = !!this._nanoOpen[g.id];
        const nanoLong = nano.length > 90;
        const nanoRow = `
            <div class="meta-section">
                <div class="meta-header">
                    <span class="meta-label">四宫格生成提示词</span>
                    ${nanoLong ? `<button class="btn-ghost btn-tiny" onclick="StoryboardModule.toggleNano('${g.id}')">${nanoOpen ? '收起 ▴' : '展开 ▾'}</button>` : ''}
                </div>
                ${InlineEdit.field(nano, {
                    placeholder: '点击填写 NANO 提示词（@图1=…）',
                    className: 'meta-content sb-nano clamp-1 ' + (nanoOpen ? 'expanded open' : ''),
                    data: { edit: 'sb-group', gid: g.id, field: 'nanoPrompt' } })}
            </div>`;

        // 四个 local 提示词行（无限列表形式），每行右侧配音按钮
        const localRows = [0, 1, 2, 3].map(i => this.renderLocalRow(g, i, idx)).join('');

        return `<div class="list-row">
            <div class="list-row-img-section">
                <div class="list-row-img sb-row-fourgrid" onclick="${fourUrl ? `CharacterModule.openImageZoom('${fourUrl}','第${idx + 1}组四宫格','')` : ''}" style="position:relative">
                    ${fourUrl
                        ? `<img src="${fourUrl}" alt="四宫格"><div class="sb-grid-lines"></div>`
                        : `<div class="sb-thumb-placeholder ${errMsg ? 'sb-thumb-error' : ''}">${placeholder}</div>`}
                </div>
                <div class="list-img-btns">
                    <button class="btn-ghost btn-tiny ${genning ? 'btn-disabled' : ''}" id="fgBtn_${g.id}" ${genning ? 'disabled' : ''}
                        onclick="${genning ? '' : `StoryboardModule.genFourGrid('${g.id}')`}">${genning ? `⏳ ${elapsed}s` : '🎨 生成'}</button>
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule.uploadFourGrid('${g.id}')">📁 上传</button>
                    ${fgHistCount > 0 ? `<button class="btn-ghost btn-tiny" title="查看本组历次生成的四宫格图并切换" onclick="StoryboardModule.showFourGridHistory('${g.id}')">📜 历史(${fgHistCount})</button>` : ''}
                </div>
                ${errMsg && !genning ? this._fgErrorTag(errMsg, g.id) : ''}
            </div>
            <div class="list-row-body">
                <div class="list-row-header">
                    <span class="list-row-name">第 ${idx + 1} 组四宫格</span>
                    <span class="sb-trans-badge sb-trans-${g.transition || 'cut'}">${this.transLabel(g.transition)}</span>
                </div>
                <div class="list-row-top-right">
                    <button class="btn-ghost btn-ghost-danger btn-tiny" onclick="StoryboardModule.delGroup('${g.id}')">🗑️ 删除</button>
                </div>
                <div class="list-row-meta">
                    ${nanoRow}
                    <div class="meta-section">
                        <div class="meta-header">
                            <span class="meta-label">分镜 local 提示词 / 配音</span>
                            <span class="sb-batch-ops">
<button class="sb-batch-btn sb-batch-sel ${allSelected ? 'on' : ''}" title="一键勾选/取消本组 4 个分镜的『合成视频』" onclick="StoryboardModule.toggleGroupSelectAll('${g.id}')">
<span class="sb-batch-ic">✓</span>${allSelected ? '取消全选' : '全选'}
</button>
<button class="sb-batch-btn sb-batch-mark ${allMarked ? 'on' : ''}" title="一键标记/取消本组 4 个分镜（置灰）" onclick="StoryboardModule.toggleGroupMarkAll('${g.id}')">
<span class="sb-batch-ic">✓</span>${allMarked ? '取消标记' : '全标记'}
</button>
                            </span>
                            <span class="sb-meta-count">${lineCount} 句台词 · 🔊 ${audioCount}/4 已配音</span>
                        </div>
                        <div class="meta-content"><div class="sb-local-list">${localRows}</div></div>
                    </div>
                    <div class="meta-section sb-row-status">
                        ${refRow}
                    </div>
                </div>
            </div>
        </div>`;
    },

    // ============================================================
    // 单分镜（自定义插入）：单图 + 单音频，用于补 CC 漏提的镜头
    // ============================================================
    // 在 afterId 这一组之后插入一个空白单分镜（afterId='' 表示插到最前）
    insertSingle(afterId) {
        const p = Storage.getProject(this.projectId);
        const groups = (p.storyboardGroups || []).slice();
        const single = {
            id: Storage._uid(),
            single: true,
            prompt: '',
            transition: 'cut',
            imageId: null,
            imageError: '',
            refImageIds: [],            // 选中的参考图 mediaId 列表（人物/道具/场景/四宫格切分）
            audioId: null,
            audioError: '',
            refAudioId: null,           // 选中的参考音色 mediaId
            dialogue: { character: '', text: '', tone: '' },
        };
        const at = afterId ? groups.findIndex(x => x.id === afterId) + 1 : 0;
        groups.splice(at, 0, single);
        Storage.updateProject(this.projectId, { storyboardGroups: groups });
        App.showToast('已插入单分镜，可设置参考图/参考音色并生成', 'success');
        this.render(this.projectId);
    },

    // 单分镜卡片
    renderSingleCard(g, idx) {
        const img = g.imageId != null ? Storage.getMediaById(this.projectId, g.imageId) : null;
        const imgUrl = img ? Storage.mediaUrl(img.data) : '';
        const aud = g.audioId != null ? Storage.getMediaById(this.projectId, g.audioId) : null;
        const audUrl = aud ? Storage.mediaUrl(aud.data) : '';
        const imgGenning = !!this._polls['si_img_' + g.id];
        const audGenning = !!this._polls['si_aud_' + g.id];
        const imgErr = g.imageError || '';
        const refImgCount = (g.refImageIds || []).length;
        const refAud = g.refAudioId != null ? Storage.getMediaById(this.projectId, g.refAudioId) : null;
        const refAudUrl = refAud ? Storage.mediaUrl(refAud.data) : '';
        const d = g.dialogue || {};

        const imgHistCount = Storage.getMediaForItem(this.projectId, 'storyboards', g.id + '_single').filter(m => m.type === 'image').length;

        const placeholder = imgGenning
            ? `<div class="sb-spinner"></div><span id="siImgTimer_${g.id}">生成中…</span>`
            : (imgErr ? '<span style="font-size:1.6rem">⚠️</span><span>生成失败</span>' : '🖼️ 待生成单图');

        const selected = g.selected !== false;  // 默认选中
        const marked = !!g.marked;

        return `<div class="list-row sb-single-row ${marked ? 'sb-marked' : (selected ? 'sb-picked' : '')}">
            <div class="list-row-img-section">
                <div class="list-row-img" onclick="${imgUrl ? `CharacterModule.openImageZoom('${imgUrl}','单分镜','')` : ''}">
                    ${imgUrl ? `<img src="${imgUrl}" alt="单分镜">` : `<div class="sb-thumb-placeholder ${imgErr ? 'sb-thumb-error' : ''}">${placeholder}</div>`}
                </div>
                <div class="list-img-btns">
                    <button class="btn-ghost btn-tiny ${imgGenning ? 'btn-disabled' : ''}" id="siImgBtn_${g.id}" ${imgGenning ? 'disabled' : ''}
                        onclick="${imgGenning ? '' : `StoryboardModule.genSingleImage('${g.id}')`}">${imgGenning ? '⏳ 生成中' : '🎨 生成'}</button>
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule.uploadSingleImage('${g.id}')">📁 上传</button>
                    ${imgHistCount > 0 ? `<button class="btn-ghost btn-tiny" title="查看本单分镜的历次生成图像并切换" onclick="StoryboardModule.showSingleImageHistory('${g.id}')">📜 历史(${imgHistCount})</button>` : ''}
                </div>
                ${imgErr && !imgGenning ? this._singleImgErrorTag(g.id, imgErr) : ''}
            </div>
            <div class="list-row-body">
                <div class="list-row-header">
                    <span class="list-row-name">🎬 单分镜</span>
                <span class="sb-trans-badge sb-trans-${g.transition || 'cut'}">${this.transLabel(g.transition)}</span>
                <label class="sb-pick-inline" title="勾选后纳入合成视频"><input type="checkbox" class="sb-pick-cb" ${selected ? 'checked' : ''} onchange="StoryboardModule.toggleSingleSelected('${g.id}',this.checked)"> 合成视频</label>
                <button class="sb-mark-btn ${marked ? 'on' : ''}" title="${marked ? '已标记，点击取消' : '标记为已处理（置灰）'}" onclick="StoryboardModule.toggleSingleMarked('${g.id}')">${marked ? '✅ 已标记' : '◻ 标记'}</button>
                </div>
                <div class="list-row-top-right">
                    <button class="btn-ghost btn-ghost-danger btn-tiny" onclick="StoryboardModule.delGroup('${g.id}')">🗑️ 删除</button>
                </div>
                <div class="list-row-meta">
                    <div class="meta-section">
                        <div class="meta-header"><span class="meta-label">画面提示词</span></div>
                        ${InlineEdit.field(g.prompt || '', {
                            placeholder: '点击填写这个分镜的画面提示词…',
                            className: 'meta-content clamp-1',
                            data: { edit: 'sb-single', gid: g.id, field: 'prompt' } })}
                    </div>
                    <div class="meta-section">
                        <div class="meta-header">
                            <span class="meta-label">参考图（${refImgCount} 张）</span>
                            <button class="btn-ghost btn-tiny" onclick="StoryboardModule.pickRefImages('${g.id}')">＋ 选择参考图</button>
                        </div>
                        <div class="meta-content sb-single-refimgs">
                            ${refImgCount ? this._renderRefImgThumbs(g) : '<span class="sb-dim-hint">未选参考图。可选人物/道具/场景图，或改分镜前生成的四宫格切分图。</span>'}
                        </div>
                    </div>
                    <div class="meta-section sb-single-dialogue">
                        <div class="meta-header">
                            <span class="meta-label">台词 / 配音</span>
                            <button class="btn-ghost btn-tiny ${audGenning ? 'btn-disabled' : ''}" id="siAudBtn_${g.id}"
                                onclick="${audGenning ? '' : `StoryboardModule.openSingleAudioModal('${g.id}')`}">${audGenning ? '⏳ 配音中' : '🔊 配音'}</button>
                        </div>
                        <div class="meta-content">
                            <div class="sb-single-line-row">
                                <div class="sb-single-text-cell">
                                    ${InlineEdit.field(d.text || '', {
                                        placeholder: '点击填写台词…',
                                        className: 'clamp-1',
                                        data: { edit: 'sb-single-dlg', gid: g.id, field: 'text' } })}
                                </div>
                                <div class="sb-single-tone-cell" title="情绪 / 语气">
                                    <span class="sb-dlg-tone-icon">🎭</span>
                                    ${InlineEdit.field(d.tone || '', {
                                        single: true, placeholder: '情绪/语气',
                                        className: 'sb-single-tone clamp-1',
                                        data: { edit: 'sb-single-dlg', gid: g.id, field: 'tone' } })}
                                </div>
                            </div>
                            <div class="sb-single-audio-row">
                                <span class="sb-dim-hint">参考音色：</span>
                                ${refAudUrl ? `<audio controls preload="none" src="${refAudUrl}" style="height:30px"></audio>` : '<span class="sb-dim-hint">未选</span>'}
                                <button class="btn-ghost btn-tiny" onclick="StoryboardModule.pickRefAudio('${g.id}')">选参考音色</button>
                            </div>
                            ${audUrl ? `<div class="sb-single-audio-row"><span class="sb-dim-hint">成品配音：</span><audio controls preload="none" src="${audUrl}" style="height:30px"></audio></div>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    },

    _renderRefImgThumbs(g) {
        return (g.refImageIds || []).map(mid => {
            const m = Storage.getMediaById(this.projectId, mid);
            if (!m) return '';
            const url = Storage.mediaUrl(m.data);
            return `<div class="sb-refimg-thumb" title="点击移除"><img src="${url}" onclick="StoryboardModule.removeRefImage('${g.id}','${mid}')"><span class="sb-refimg-x">×</span></div>`;
        }).join('');
    },

    _singleImgErrorTag(gid, msg) {
        const full = encodeURIComponent(String(msg || ''));
        const brief = String(msg || '').replace(/\s+/g, ' ').slice(0, 14);
        return `<div class="gen-err-tag" title="点击查看完整错误" onclick="StoryboardModule.showFgError('${full}')">`
            + `<span class="gen-err-txt">⚠️ ${this.esc(brief)}${String(msg).length > 14 ? '…' : ''}</span>`
            + `<span class="gen-err-x" title="忽略" onclick="event.stopPropagation();StoryboardModule.clearImgError('${gid}')">✕</span>`
            + `</div>`;
    },

    // × 关闭：清除单图生成错误
    clearImgError(gid) {
        if (!gid) return;
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => String(x.id) === String(gid));
        if (g && g.imageError) {
            delete g.imageError;
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        }
        this.render(this.projectId);
    },

    // × 关闭：清除四宫格生成错误
    clearFgError(gid) {
        if (!gid) return;
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => String(x.id) === String(gid));
        if (g && g.fourGridError) {
            delete g.fourGridError;
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        }
        this.render(this.projectId);
    },

    removeRefImage(gid, mid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        g.refImageIds = (g.refImageIds || []).filter(x => String(x) !== String(mid));
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);
    },

    // ===== 收集「前期所有图像」：人物/道具/场景的所有图 + 所有四宫格切分 panel 图 =====
    _allImageAssets() {
        const p = Storage.getProject(this.projectId);
        const lib = p.mediaLibrary || [];
        const nameOf = (type, ownerId) => {
            const list = type === 'characters' ? (p.characters || []) : (type === 'props' ? (p.props || []) : (p.scenes || []));
            const it = list.find(x => String(x.id) === String(ownerId));
            return it ? it.name : '';
        };
        const groups = [
            { key: 'characters', label: '👤 人物' },
            { key: 'props', label: '🎁 道具' },
            { key: 'scenes', label: '🏞️ 场景' },
        ];
        const out = [];
        groups.forEach(grp => {
            const items = lib.filter(m => m.type === 'image' && m.ownerType === grp.key);
            items.forEach(m => out.push({
                id: m.id, url: Storage.mediaUrl(m.data),
                group: grp.label, name: nameOf(grp.key, m.ownerId) || grp.label,
            }));
        });
        // 四宫格切分图 / 改分镜前生成的四宫格图（ownerType=storyboards）
        const sbImgs = lib.filter(m => m.type === 'image' && m.ownerType === 'storyboards');
        sbImgs.forEach(m => out.push({
            id: m.id, url: Storage.mediaUrl(m.data),
            group: '🎞️ 四宫格/切分', name: '分镜图 #' + m.id,
        }));
        return out;
    },

    // ===== 选择参考图弹窗（多选，含全部前期图像）=====
    pickRefImages(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const all = this._allImageAssets();
        const chosen = new Set((g.refImageIds || []).map(String));
        if (!all.length) { App.showToast('暂无可选图像，请先在人物/道具/场景页生成图，或生成四宫格', 'info'); return; }

        // 按 group 分组展示
        const byGroup = {};
        all.forEach(a => { (byGroup[a.group] = byGroup[a.group] || []).push(a); });
        const sections = Object.keys(byGroup).map(grp => `
            <div class="sb-pick-section">
                <div class="sb-pick-section-title">${grp}（${byGroup[grp].length}）</div>
                <div class="sb-pick-grid">
                    ${byGroup[grp].map(a => `
                        <label class="sb-pick-cell ${chosen.has(String(a.id)) ? 'selected' : ''}" data-id="${a.id}">
                            <input type="checkbox" value="${a.id}" ${chosen.has(String(a.id)) ? 'checked' : ''} onchange="this.closest('.sb-pick-cell').classList.toggle('selected', this.checked)">
                            <img src="${a.url}" loading="lazy">
                            <span class="sb-pick-name">${this.esc(a.name)}</span>
                        </label>`).join('')}
                </div>
            </div>`).join('');

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🖼️ 选择参考图（可多选）</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body sb-pick-body">
                <p class="form-hint">从前期生成的所有图像中选择，作为本单分镜的参考图。支持人物/道具/场景图，以及改分镜前生成的四宫格及其切分图。</p>
                ${sections}
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" onclick="StoryboardModule._saveRefImages('${gid}')">确定</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    _saveRefImages(gid) {
        const checks = document.querySelectorAll('#modalContent .sb-pick-cell input[type=checkbox]:checked');
        const ids = Array.from(checks).map(c => parseInt(c.value)).filter(v => !isNaN(v));
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (g) {
            g.refImageIds = ids;
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        }
        App.closeModal();
        App.showToast(`已选 ${ids.length} 张参考图`, 'success');
        this.render(this.projectId);
    },

    // ===== 收集「前期所有音频」：人物/道具/场景 + 已生成的分镜配音 =====
    _allAudioAssets() {
        const p = Storage.getProject(this.projectId);
        const lib = p.mediaLibrary || [];
        const nameOf = (type, ownerId) => {
            const list = type === 'characters' ? (p.characters || []) : (type === 'props' ? (p.props || []) : (p.scenes || []));
            const it = list.find(x => String(x.id) === String(ownerId));
            return it ? it.name : '';
        };
        const out = [];
        lib.filter(m => m.type === 'audio').forEach(m => {
            let label = '🎬 分镜配音', name = '配音 #' + m.id;
            if (m.ownerType === 'characters') { label = '👤 人物音色'; name = nameOf('characters', m.ownerId) || '人物'; }
            else if (m.ownerType === 'props') { label = '🎁 道具'; name = nameOf('props', m.ownerId) || '道具'; }
            else if (m.ownerType === 'scenes') { label = '🏞️ 场景'; name = nameOf('scenes', m.ownerId) || '场景'; }
            out.push({ id: m.id, url: Storage.mediaUrl(m.data), group: label, name, createdAt: m.createdAt });
        });
        return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    // ===== 选择参考音色弹窗（单选）=====
    pickRefAudio(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const all = this._allAudioAssets();
        if (!all.length) { App.showToast('暂无可选音频，请先在人物页生成音色', 'info'); return; }
        const cur = g.refAudioId != null ? String(g.refAudioId) : '';

        const rows = all.map(a => `
            <label class="sb-pick-audio-row ${cur === String(a.id) ? 'selected' : ''}">
                <input type="radio" name="refAud" value="${a.id}" ${cur === String(a.id) ? 'checked' : ''}>
                <span class="sb-pick-audio-tag">${a.group}</span>
                <span class="sb-pick-audio-name">${this.esc(a.name)}</span>
                <audio controls preload="none" src="${a.url}" style="height:30px;margin-left:auto"></audio>
            </label>`).join('');

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🔊 选择参考音色</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body sb-pick-body">
                <p class="form-hint">从前期所有音频中选择一个作为本单分镜配音的参考音色（声音克隆来源）。</p>
                <div class="sb-pick-audio-list">${rows}</div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" onclick="StoryboardModule._saveRefAudio('${gid}')">确定</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    _saveRefAudio(gid) {
        const sel = document.querySelector('#modalContent input[name=refAud]:checked');
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (g) {
            g.refAudioId = sel ? parseInt(sel.value) : null;
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        }
        App.closeModal();
        App.showToast(sel ? '已选参考音色' : '已清除参考音色', 'success');
        this.render(this.projectId);
    },

    // ===== 单分镜：生成单图（走四宫格同一编辑接口，参考图=选中的所有参考图）=====
    async genSingleImage(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        if (!(g.prompt || '').trim()) { App.showToast('请先填写画面提示词', 'error'); return; }

        // 收集参考图 b64
        const refB64 = [];
        for (const mid of (g.refImageIds || [])) {
            const m = Storage.getMediaById(this.projectId, mid);
            if (!m) continue;
            const b64 = await this._urlToB64(Storage.mediaUrl(m.data));
            if (b64) refB64.push(b64);
        }
        if (!refB64.length) {
            const ok = await App.confirm({
                title: '⚠️ 没有参考图',
                message: '本单分镜没有选择任何参考图，编辑接口至少需要一张参考图。\n是否仍要尝试生成？',
                okText: '仍要生成', cancelText: '去选图',
            });
            if (!ok) return;
        }

        // API 分组：复用图像设置里的默认分组
        const groupsCfg = (Storage.getSettings().imageGroups || []);
        const activeGroup = groupsCfg.find(x => x.active) || groupsCfg[0];
        if (!activeGroup) { App.showToast('请先在设置里配置图像 API 分组', 'error'); return; }
        const defs = (Storage.getSettings().imageDefaults || {});

        try {
            const submit = await API.post('/api/storyboard/fourgrid', {
                prompt: g.prompt,
                ref_images: refB64,
                api_url: activeGroup.url,
                api_key: activeGroup.apiKey,
                model: (activeGroup.models && activeGroup.models.find(m => /image/i.test(m))) || 'gpt-image-2',
                size: defs.size || 'auto',
                quality: defs.quality || 'auto',
            });
            if (!submit.success || !submit.task_id) throw new Error(submit.error || '提交失败');
            this._polls['si_img_' + gid] = submit.task_id;
            g.imageError = '';
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
            this.render(this.projectId);
            this._pollSingleImage(gid, submit.task_id);
        } catch (e) {
            g.imageError = e.message || '提交失败';
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
            App.showToast('单分镜图像生成失败：' + e.message, 'error');
            this.render(this.projectId);
        }
    },

    async _pollSingleImage(gid, taskId) {
        try {
            const result = await this._pollTask(taskId, null);
            delete this._polls['si_img_' + gid];
            const pp = Storage.getProject(this.projectId);
            const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
            if (!gg) return;
            if (result && result.images && result.images[0]) {
                const dataUrl = 'data:image/png;base64,' + result.images[0];
                const dims = await CharacterModule.computeDims(dataUrl);
                const entry = await Storage._addMedia(this.projectId, 'image', 'storyboards', gid + '_single', dataUrl, null, dims);
                gg.imageId = entry.id;
                gg.imageError = '';
                App.showToast('✅ 单分镜图已生成', 'success');
            } else {
                gg.imageError = '未获取到图像数据';
                App.showToast('单分镜图像生成失败', 'error');
            }
            Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups });
            this.render(this.projectId);
        } catch (e) {
            delete this._polls['si_img_' + gid];
            const pp = Storage.getProject(this.projectId);
            const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
            if (gg) { gg.imageError = e.message || '生成异常'; Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups }); }
            App.showToast('单分镜图像生成失败：' + e.message, 'error');
            this.render(this.projectId);
        }
    },

    uploadSingleImage(gid) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = async e => {
            const f = e.target.files[0]; if (!f) return;
            const r = new FileReader();
            r.onload = async ev => {
                const data = ev.target.result;
                const dims = await CharacterModule.computeDims(data);
                const entry = await Storage._addMedia(this.projectId, 'image', 'storyboards', gid + '_single', data, null, dims);
                const pp = Storage.getProject(this.projectId);
                const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
                if (gg) { gg.imageId = entry.id; gg.imageError = ''; Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups }); }
                App.showToast('✅ 已上传单分镜图', 'success');
                this.render(this.projectId);
            };
            r.readAsDataURL(f);
        };
        inp.click();
    },

    // ===== 四宫格：图像历史画廊（历次生成的四宫格图，可设为当前 / 删除；切换后自动重新切分面板） =====
    showFourGridHistory(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const images = Storage.getMediaForItem(this.projectId, 'storyboards', gid).filter(m => m.type === 'image')
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const mc = document.getElementById('modalContent');
        const galleryHtml = images.map(m => {
            const dim = (m.width && m.height) ? `${m.width} × ${m.height}` : '#' + m.id;
            const url = Storage.mediaUrl(m.data);
            const isCur = m.id === g.fourGridImageId;
            return `<div class="gallery-item ${isCur ? 'selected' : ''}">
                ${isCur ? '<div class="gallery-current-badge">✓ 当前使用</div>' : ''}
                <div class="gallery-img-wrap">
                    <img src="${url}" loading="lazy" onclick="CharacterModule.openImageZoom('${url}','四宫格','${dim}')">
                    <div class="gallery-zoom-hint">🔍 点击放大</div>
                </div>
                <div class="gallery-item-actions">
                    <button class="gallery-select-btn" title="设为当前并重新切分面板" onclick="StoryboardModule.selFourGridImage('${gid}',${m.id})">✓</button>
                    <button class="gallery-delete-btn" title="删除" onclick="StoryboardModule.delFourGridImage('${gid}',${m.id})">×</button>
                </div>
                <div class="gallery-dim-label">${dim}</div>
            </div>`;
        }).join('');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">📷 四宫格图像历史</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
        <div class="modal-body">${images.length ? `<div class="gallery-count">共 ${images.length} 张图像（切换后将重新切分为 4 个面板）</div><div class="image-gallery">${galleryHtml}</div>` : `<div class="empty-state"><div class="empty-state-icon">📷</div><div class="empty-state-text">暂无四宫格图像，去生成或上传吧</div></div>`}</div>
        <div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">关闭</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    async selFourGridImage(gid, mid) {
        mid = parseInt(mid);
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        const m = Storage.getMediaById(this.projectId, mid);
        if (!g || !m) return;
        g.fourGridImageId = mid;
        g.fourGridError = '';
        try { await this._splitFourGrid(g, Storage.mediaUrl(m.data)); } catch (e) { /* 切分失败不阻断 */ }
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.showToast('已设为当前四宫格并重新切分面板', 'success');
        this.showFourGridHistory(gid);
        this.render(this.projectId);
    },

    delFourGridImage(gid, mid) {
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">确认删除</h2></div>
        <div class="modal-body"><p style="text-align:center;padding:1rem">确定要删除这张四宫格图像吗？此操作不可撤销。</p></div>
        <div class="modal-footer"><button class="btn-secondary" onclick="StoryboardModule.showFourGridHistory('${gid}')">取消</button>
        <button class="btn-danger" onclick="StoryboardModule.doDelFourGridImage('${gid}',${mid})">确认删除</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    async doDelFourGridImage(gid, mid) {
        mid = parseInt(mid);
        Storage.deleteMediaItem(this.projectId, mid);
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (g && g.fourGridImageId === mid) {
            const rest = Storage.getMediaForItem(this.projectId, 'storyboards', gid).filter(m => m.type === 'image')
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            if (rest.length) {
                g.fourGridImageId = rest[0].id;
                try { await this._splitFourGrid(g, Storage.mediaUrl(rest[0].data)); } catch (e) { /* ignore */ }
            } else {
                g.fourGridImageId = null;
            }
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        }
        App.showToast('已删除', 'success');
        this.showFourGridHistory(gid);
        this.render(this.projectId);
    },

    // ===== 单分镜：图像历史画廊（仿人物图像历史，可设为当前 / 删除） =====
    showSingleImageHistory(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const images = Storage.getMediaForItem(this.projectId, 'storyboards', gid + '_single').filter(m => m.type === 'image')
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const mc = document.getElementById('modalContent');
        const galleryHtml = images.map(m => {
            const dim = (m.width && m.height) ? `${m.width} × ${m.height}` : '#' + m.id;
            const url = Storage.mediaUrl(m.data);
            const isCur = m.id === g.imageId;
            return `<div class="gallery-item ${isCur ? 'selected' : ''}">
                ${isCur ? '<div class="gallery-current-badge">✓ 当前使用</div>' : ''}
                <div class="gallery-img-wrap">
                    <img src="${url}" loading="lazy" onclick="CharacterModule.openImageZoom('${url}','单分镜','${dim}')">
                    <div class="gallery-zoom-hint">🔍 点击放大</div>
                </div>
                <div class="gallery-item-actions">
                    <button class="gallery-select-btn" title="设为当前" onclick="StoryboardModule.selSingleImage('${gid}',${m.id})">✓</button>
                    <button class="gallery-delete-btn" title="删除" onclick="StoryboardModule.delSingleImage('${gid}',${m.id})">×</button>
                </div>
                <div class="gallery-dim-label">${dim}</div>
            </div>`;
        }).join('');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">📷 单分镜图像历史</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
        <div class="modal-body">${images.length ? `<div class="gallery-count">共 ${images.length} 张图像</div><div class="image-gallery">${galleryHtml}</div>` : `<div class="empty-state"><div class="empty-state-icon">📷</div><div class="empty-state-text">暂无图像，去生成或上传吧</div></div>`}</div>
        <div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">关闭</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    selSingleImage(gid, mid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (g) { g.imageId = parseInt(mid); g.imageError = ''; Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups }); }
        App.showToast('已设为当前图像', 'success');
        this.showSingleImageHistory(gid);
        this.render(this.projectId);
    },

    delSingleImage(gid, mid) {
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">确认删除</h2></div>
        <div class="modal-body"><p style="text-align:center;padding:1rem">确定要删除这张图像吗？此操作不可撤销。</p></div>
        <div class="modal-footer"><button class="btn-secondary" onclick="StoryboardModule.showSingleImageHistory('${gid}')">取消</button>
        <button class="btn-danger" onclick="StoryboardModule.doDelSingleImage('${gid}',${mid})">确认删除</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    doDelSingleImage(gid, mid) {
        mid = parseInt(mid);
        Storage.deleteMediaItem(this.projectId, mid);
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (g && g.imageId === mid) {
            // 当前被删 → 回退到最近一张历史，否则置空
            const rest = Storage.getMediaForItem(this.projectId, 'storyboards', gid + '_single').filter(m => m.type === 'image')
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            g.imageId = rest.length ? rest[0].id : null;
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        }
        App.showToast('已删除', 'success');
        this.showSingleImageHistory(gid);
        this.render(this.projectId);
    },

    // ===== 单分镜配音弹窗：改台词/语气，听参考音色，生成配音 =====
    openSingleAudioModal(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const d = g.dialogue || {};
        const refAud = g.refAudioId != null ? Storage.getMediaById(this.projectId, g.refAudioId) : null;
        const refUrl = refAud ? Storage.mediaUrl(refAud.data) : '';
        const curAud = g.audioId != null ? Storage.getMediaById(this.projectId, g.audioId) : null;
        const curUrl = curAud ? Storage.mediaUrl(curAud.data) : '';

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🔊 单分镜配音</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">语气 / 风格</label>
                    <input class="form-input" id="ssTone" value="${this.esc(d.tone || '')}" placeholder="例如：低沉、温柔、激动">
                </div>
                <div class="form-group">
                    <label class="form-label">台词文本</label>
                    <textarea class="form-textarea" id="ssText" style="min-height:72px" placeholder="本分镜要说的话">${this.esc(d.text || '')}</textarea>
                </div>
                <div class="sb-audio-ref">
                    <span class="sb-audio-ref-label">参考音色</span>
                    ${refUrl ? `<audio controls preload="none" src="${refUrl}"></audio>` : '<span class="sb-audio-ref-miss">尚未选择参考音色</span>'}
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule.pickRefAudio('${gid}')">选参考音色</button>
                </div>
                ${curUrl ? `<div class="sb-audio-ref"><span class="sb-audio-ref-label">当前配音</span><audio controls preload="none" src="${curUrl}"></audio></div>` : ''}
                <div id="ssResult" style="margin-top:0.6rem"></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">关闭</button>
                <button class="btn-primary" id="ssGenBtn" onclick="StoryboardModule.doGenSingleAudio('${gid}')">▶ 生成配音</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    async doGenSingleAudio(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const text = (document.getElementById('ssText') || {}).value || '';
        const tone = (document.getElementById('ssTone') || {}).value || '';
        if (!text.trim()) { App.showToast('请先填写台词', 'error'); return; }
        // 回写台词/语气
        g.dialogue = Object.assign({}, g.dialogue, { text: text.trim(), tone: tone.trim() });
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });

        const refAud = g.refAudioId != null ? Storage.getMediaById(this.projectId, g.refAudioId) : null;
        if (!refAud) { App.showToast('请先选择参考音色', 'error'); return; }
        const refB64 = await this._urlToB64(Storage.mediaUrl(refAud.data));
        if (!refB64) { App.showToast('参考音色加载失败', 'error'); return; }

        const btn = document.getElementById('ssGenBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 生成中…'; }
        const res = document.getElementById('ssResult');
        if (res) res.innerHTML = '<span class="sb-dim-hint">⏳ 正在克隆音色生成配音…</span>';
        this._polls['si_aud_' + gid] = true;
        this.render(this.projectId);
        // 重新打开弹窗（render 会刷新底层列表，但弹窗内容还在）
        try {
            const submit = await API.post('/api/storyboard/tts_clone', {
                ref_audio_b64: refB64, ref_audio_mime: refAud.mime || 'audio/wav',
                text: text.trim(), ref_text: tone.trim(),
            });
            if (!submit.success || !submit.task_id) throw new Error(submit.error || '提交失败');
            const result = await this._pollTask(submit.task_id, null, 1200);
            delete this._polls['si_aud_' + gid];
            if (result && result.audio_base64) {
                const dataUrl = 'data:audio/wav;base64,' + result.audio_base64;
                const entry = await Storage._addMedia(this.projectId, 'audio', 'storyboards', gid + '_singleaudio', dataUrl, 'audio/wav');
                const pp = Storage.getProject(this.projectId);
                const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
                if (gg) { gg.audioId = entry.id; gg.audioError = ''; Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups }); }
                App.showToast('✅ 单分镜配音完成', 'success');
                this.render(this.projectId);
                this.openSingleAudioModal(gid);
            } else {
                throw new Error('未产出音频');
            }
        } catch (e) {
            delete this._polls['si_aud_' + gid];
            App.showToast('配音失败：' + e.message, 'error');
            this.render(this.projectId);
            this.openSingleAudioModal(gid);
        }
    },

    // 单条 local 提示词行：序号 + 切分小图 + local 提示词 + 台词/人物 + 右侧配音按钮/播放/历史
    renderLocalRow(g, i, gIdx) {
        const d = (g.dialogues || [])[i] || {};
        const imgId = (g.panelImages || [])[i];
        const pImg = imgId ? Storage.getMediaById(this.projectId, imgId) : null;
        const pUrl = pImg ? Storage.mediaUrl(pImg.data) : '';
        const audId = (g.panelAudios || [])[i];
        const aud = audId ? Storage.getMediaById(this.projectId, audId) : null;
        const audUrl = aud ? Storage.mediaUrl(aud.data) : '';
        const local = (g.localPrompts || [])[i] || '';
        const who = d.character ? this.esc(d.character) : '';
        const line = d.text ? this.esc(d.text) : '';
        const zoomTitle = `第${gIdx + 1}组·面板${i + 1}`;
        const key = g.id + ':' + i;
        const audioing = !!this._audioTasks[key];
        const aElapsed = audioing ? Math.round((Date.now() - this._audioTasks[key]) / 1000) : 0;
        const histCount = Storage.getMediaForItem(this.projectId, 'storyboards', g.id + '_audio' + i).filter(m => m.type === 'audio').length;

        const tone = d.tone || '';
        // 选择合成视频（默认选中）/ 手动标记（标记后置灰）
        const selected = !(g.panelSelected && g.panelSelected[i] === false);
        const marked = !!(g.panelMarked && g.panelMarked[i]);
        return `<div class="sb-local-row ${marked ? 'sb-marked' : (selected ? 'sb-picked' : '')}">
            <div class="sb-local-pick" title="勾选后纳入合成视频">
                <input type="checkbox" class="sb-pick-cb" ${selected ? 'checked' : ''} onchange="StoryboardModule.togglePanelSelected('${g.id}',${i},this.checked)">
                <button class="sb-mark-btn ${marked ? 'on' : ''}" title="${marked ? '已标记，点击取消' : '标记为已处理（置灰）'}" onclick="StoryboardModule.togglePanelMarked('${g.id}',${i})">${marked ? '✅' : '◻'}</button>
            </div>
            <div class="sb-local-thumb" onclick="${pUrl ? `CharacterModule.openImageZoom('${pUrl}','${zoomTitle}','')` : ''}">
                ${pUrl ? `<img src="${pUrl}" alt="面板${i + 1}">` : `<span class="sb-local-no">${i + 1}</span>`}
                <span class="sb-local-badge">${i + 1}</span>
            </div>
            <div class="sb-local-main">
                ${InlineEdit.field(local, {
                    placeholder: '点击填写 local 提示词…',
                    className: 'sb-local-prompt clamp-1',
                    data: { edit: 'sb-panel', gid: g.id, panel: i, field: 'local' } })}
                <div class="sb-local-dialogue">
                    <div class="sb-dlg-line1">
                        ${this._panelCharSelect(g, i, d.character || '')}
                        <div class="sb-local-audio-btns">
                            <button class="btn-ghost btn-tiny ${audioing ? 'btn-disabled' : ''}" id="sbA_${g.id}_${i}"
                                onclick="${audioing ? '' : `StoryboardModule.openAudioModal('${g.id}',${i})`}">${audioing ? `⏳ ${aElapsed}s` : (audUrl ? '🔄 配音' : '🔊 配音')}</button>
                            <button class="btn-ghost btn-tiny ${audUrl ? '' : 'btn-disabled'}" id="sbAplay_${g.id}_${i}"
                                onclick="${audUrl ? `StoryboardModule.togglePanelPlay('${g.id}',${i})` : ''}">▶ 播放</button>
                            <button class="btn-ghost btn-tiny ${histCount ? '' : 'btn-disabled'}"
                                onclick="${histCount ? `StoryboardModule.showAudioHistory('${g.id}',${i})` : ''}">📜 历史${histCount ? `(${histCount})` : ''}</button>
                        </div>
                    </div>
                    <div class="sb-dlg-line2">
                        ${InlineEdit.field(d.text || '', {
                            placeholder: '台词…',
                            className: 'sb-dlg-text',
                            data: { edit: 'sb-panel', gid: g.id, panel: i, field: 'text' } })}
                        <span class="sb-dlg-tone-wrap">
                            <span class="sb-dlg-tone-icon">🎭</span>
                            ${InlineEdit.field(tone, {
                                single: true, placeholder: '语气',
                                className: 'sb-dlg-tone clamp-1',
                                data: { edit: 'sb-panel', gid: g.id, panel: i, field: 'tone' } })}
                        </span>
                    </div>
                </div>
                ${audUrl ? `<audio id="sbAaudio_${g.id}_${i}" preload="none" src="${audUrl}" style="display:none"></audio>` : ''}
            </div>
        </div>`;
    },

    // 说话人人物下拉：选人物→自动匹配其音色；标注是否已有音色，缺音色给提示
    _panelCharSelect(g, i, cur) {
        const p = Storage.getProject(this.projectId);
        const chars = p.characters || [];
        const curChar = chars.find(c => c.name === cur);
        const hasVoice = curChar ? !!Storage.getSelectedMedia(this.projectId, 'characters', curChar, 'audio') : false;
        const opts = ['<option value="">— 选择人物 —</option>']
            .concat(chars.map(c => {
                const v = !!Storage.getSelectedMedia(this.projectId, 'characters', c, 'audio');
                return `<option value="${this.esc(c.name)}" ${c.name === cur ? 'selected' : ''}>${this.esc(c.name)}${v ? ' 🔊' : ''}</option>`;
            }))
            .join('');
        // 选中了人物但该人物没有音色 → 名牌右侧给一个⚠️提示
        const warn = (cur && !hasVoice) ? '<span class="sb-dlg-novoice" title="该人物尚无音色，请先到人物页生成音频">⚠️</span>' : '';
        return `<div class="sb-dlg-who-wrap">
            <select class="sb-dlg-who-select ${cur ? '' : 'is-empty'}" onchange="StoryboardModule.setPanelCharacter('${g.id}',${i},this.value)">${opts}</select>
            ${warn}
        </div>`;
    },

    // 下拉选择说话人 → 写回 dialogue.character（配音时按此名字自动匹配人物音色）
    setPanelCharacter(gid, i, name) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        if (!Array.isArray(g.dialogues)) g.dialogues = [];
        const d = g.dialogues[i] || { panel: i + 1 };
        d.character = name || '';
        g.dialogues[i] = d;
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);
    },

    // 行内「▶ 播放 / ⏸」：播放该 panel 当前配音音频（与其它行内播放互斥）
    togglePanelPlay(gid, i) {
        const a = document.getElementById('sbAaudio_' + gid + '_' + i);
        const b = document.getElementById('sbAplay_' + gid + '_' + i);
        if (!a) return;
        a.onended = () => { if (b) b.textContent = '▶ 播放'; this._curRowAudio = null; };
        if (a.paused) {
            if (this._curRowAudio && this._curRowAudio !== a) {
                this._curRowAudio.pause();
                const prev = this._curRowAudio._btn;
                if (prev) prev.textContent = '▶ 播放';
            }
            a.play(); a._btn = b; this._curRowAudio = a;
            if (b) b.textContent = '⏸ 暂停';
        } else {
            a.pause();
            if (b) b.textContent = '▶ 播放';
            this._curRowAudio = null;
        }
    },

    // 勾选/取消「纳入合成视频」（四宫格某一面板）
    togglePanelSelected(gid, i, checked) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        if (!Array.isArray(g.panelSelected)) g.panelSelected = [true, true, true, true];
        g.panelSelected[i] = !!checked;
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);  // 重绘以更新选中高亮
    },

    // 标记/取消标记（四宫格某一面板）：标记后置灰；标记时自动取消「合成视频」勾选
    togglePanelMarked(gid, i) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        if (!Array.isArray(g.panelMarked)) g.panelMarked = [false, false, false, false];
        if (!Array.isArray(g.panelSelected)) g.panelSelected = [true, true, true, true];
        g.panelMarked[i] = !g.panelMarked[i];
        if (g.panelMarked[i]) g.panelSelected[i] = false;  // 标记 → 自动取消合成勾选
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);
    },

    // 一键全选/取消全选本组 4 个分镜的「合成视频」
    toggleGroupSelectAll(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const allSelected = [0, 1, 2, 3].every(i => !(g.panelSelected && g.panelSelected[i] === false));
        const next = !allSelected;  // 已全选 → 取消全选；否则全选
        g.panelSelected = [next, next, next, next];
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);
    },

    // 一键全标记/取消标记本组 4 个分镜
    toggleGroupMarkAll(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const allMarked = [0, 1, 2, 3].every(i => !!(g.panelMarked && g.panelMarked[i]));
        const next = !allMarked;  // 已全标记 → 取消；否则全标记
        g.panelMarked = [next, next, next, next];
        if (next) g.panelSelected = [false, false, false, false];  // 全标记 → 自动取消全部合成勾选
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);
    },

    // 把当前「已勾选合成」的分镜一键标记为已处理（标记后置灰并取消勾选，与单个标记行为一致）
    markGroupSelected(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        if (!Array.isArray(g.panelMarked)) g.panelMarked = [false, false, false, false];
        if (!Array.isArray(g.panelSelected)) g.panelSelected = [true, true, true, true];
        // 已勾选合成 = panelSelected[i] !== false
        const targets = [0, 1, 2, 3].filter(i => g.panelSelected[i] !== false);
        if (!targets.length) { App.showToast('当前没有勾选『合成视频』的分镜', 'info'); return; }
        targets.forEach(i => { g.panelMarked[i] = true; g.panelSelected[i] = false; });
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.showToast(`已标记 ${targets.length} 个分镜`, 'success');
        this.render(this.projectId);
    },

    // 全局：把所有组中当前「已勾选合成」的分镜一键标记为已处理（置灰并取消勾选）
    markAllSelectedGlobal() {
        const p = Storage.getProject(this.projectId);
        const groups = p.storyboardGroups || [];
        if (!groups.length) return;
        let count = 0;
        groups.forEach(g => {
            if (g.single) {
                // 单分镜：用 g.selected / g.marked（默认 selected 视为 true）
                if (g.selected !== false) {
                    g.marked = true;
                    g.selected = false;
                    count++;
                }
                return;
            }
            // 四宫格组：用 panelSelected[] / panelMarked[]
            if (!Array.isArray(g.panelMarked)) g.panelMarked = [false, false, false, false];
            if (!Array.isArray(g.panelSelected)) g.panelSelected = [true, true, true, true];
            [0, 1, 2, 3].forEach(i => {
                if (g.panelSelected[i] !== false) {   // 已勾选合成
                    g.panelMarked[i] = true;
                    g.panelSelected[i] = false;
                    count++;
                }
            });
        });
        if (!count) { App.showToast('当前没有勾选『合成视频』的分镜', 'info'); return; }
        Storage.updateProject(this.projectId, { storyboardGroups: groups });
        App.showToast(`已标记全局 ${count} 个分镜`, 'success');
        this.render(this.projectId);
    },

    // 勾选/取消「纳入合成视频」（单分镜）
    toggleSingleSelected(gid, checked) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        g.selected = !!checked;
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);  // 重绘以更新选中高亮
    },

    // 标记/取消标记（单分镜）：标记时自动取消「合成视频」勾选
    toggleSingleMarked(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        g.marked = !g.marked;
        if (g.marked) g.selected = false;  // 标记 → 自动取消合成勾选
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);
    },

    transLabel(t) { return ({ cut: '硬切', smooth: '平滑', fade: '淡入淡出' })[t] || '硬切'; },

    // 检查本组生成四宫格 / 配音所需的素材是否齐备。
    // 注意：分镜不复制图/音，而是引用素材页『当前选中』的图/音——
    // 用户在人物/道具/场景页换图换音后，这里与生成结果都会自动跟随，无需手动同步。
    // 参考图检查已统一走 _collectRefAssets（人物/道具/场景都会检查）。
    _checkRefStatus(g) {
        const p = Storage.getProject(this.projectId);
        const assets = this._collectRefAssets(g);
        const missingImg = assets.filter(a => a.missing).map(a => `${a.name}(${this._typeLabel(a.type)})`);
        const imgCount = assets.filter(a => !a.missing).length;
        // 音色仅对有台词的角色检查
        const missingAudio = [];
        let audioCount = 0;
        const charNames = Array.from(new Set((g.dialogues || []).map(d => d.character).filter(Boolean)));
        for (const name of charNames) {
            const c = (p.characters || []).find(x => x.name === name);
            const hasLine = (g.dialogues || []).some(d => d.character === name && d.text && d.text.trim());
            if (!hasLine) continue;
            if (c && Storage.getSelectedMedia(this.projectId, 'characters', c, 'audio')) audioCount++;
            else missingAudio.push(name);
        }
        return { missingImg, missingAudio, imgCount, audioCount };
    },

    _typeLabel(t) { return t === 'character' ? '人物' : (t === 'prop' ? '道具' : '场景'); },

    // ============================================================
    // ① 智能生成分镜（调用 CC）
    // ============================================================
    startGenerate() {
        const p = Storage.getProject(this.projectId);
        const script = p.script || '';
        const s = Storage.getSettings();
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">✨ 智能生成分镜</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                ${script ? '' : '<div class="sb-warn">⚠️ 当前项目还没有剧本，请先到「剧本」页填写。</div>'}
                <div class="sb-gen-stats">
                    <div class="sb-stat"><span class="sb-stat-num">${(p.characters || []).length}</span><span class="sb-stat-label">人物</span></div>
                    <div class="sb-stat"><span class="sb-stat-num">${(p.props || []).length}</span><span class="sb-stat-label">道具</span></div>
                    <div class="sb-stat"><span class="sb-stat-num">${(p.scenes || []).length}</span><span class="sb-stat-label">场景</span></div>
                    <div class="sb-stat"><span class="sb-stat-num">${script.length}</span><span class="sb-stat-label">剧本字数</span></div>
                </div>
                <p class="form-hint">将把剧本 + 已生成的人物/道具/场景设定发送给 Claude，自动拆分四宫格分镜（含四宫格提示词、每分镜 local 提示词、全局提示词、台词人物映射）。</p>
                <div class="form-group">
                    <label class="form-label">分镜提取提示词（可临时修改，默认取设置）</label>
                    <textarea class="form-textarea" id="sbGenPrompt" style="min-height:120px">${this.esc(s.storyboardPrompt || '')}</textarea>
                </div>
                <div id="sbGenStatus"></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" id="sbGenClose" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" id="sbGenBtn" onclick="StoryboardModule.doGenerate()" ${script ? '' : 'disabled'}>▶ 开始生成</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    // 提交 CC 生成任务。提交成功后立即把 taskId 写入 localStorage，
    // 弹窗切换为「执行中」视图（与提取人物外观一致），可随时关闭，后台继续轮询。
    async doGenerate() {
        const p = Storage.getProject(this.projectId);
        const prompt = document.getElementById('sbGenPrompt').value.trim();
        const btn = document.getElementById('sbGenBtn');
        const statusEl = document.getElementById('sbGenStatus');
        btn.disabled = true; btn.textContent = '⏳ 提交中…';
        statusEl.innerHTML = '<div class="sb-cc-running"><div class="sb-spinner"></div> 正在提交任务…</div>';

        try {
            const submit = await API.post('/api/storyboard/generate', {
                project_id: this.projectId,
                script: p.script || '',
                prompt,
                characters: (p.characters || []).map(c => ({ name: c.name, appearance: c.description, voice: c.voice })),
                props: (p.props || []).map(x => ({ name: x.name, description: x.description })),
                scenes: (p.scenes || []).map(x => ({ name: x.name, description: x.description })),
            });
            if (!submit.success || !submit.task_id) throw new Error(submit.error || '提交失败');

            // 持久化任务（刷新/关闭弹窗后仍可恢复）
            this._saveGenTask({ taskId: submit.task_id, projectId: this.projectId, start: Date.now() });
            try { localStorage.removeItem(this._SB_RESULT_KEY); } catch (e) {}  // 新任务覆盖上次结果横幅
            App.showToast('🎬 已提交，Claude 正在后台拆分分镜，可关闭弹窗继续等待', 'info');
            // 立即重渲染分镜页：主按钮置灰转圈并启动计时器（render 末尾的 _resumeGenTask 会接管轮询与计时）
            if (this.projectId) this.render(this.projectId);
            // 切换为执行中视图（cc-terminal 外观，与提取人物一致）
            this._showGenRunningModal();
        } catch (e) {
            statusEl.innerHTML = `<div class="sb-err">❌ ${this.esc(e.message)}</div>`;
            btn.disabled = false; btn.textContent = '▶ 重试';
        }
    },

    // ===== CC 生成任务持久化 / 恢复（参照提取人物，刷新不丢、可关闭后台继续）=====
    _saveGenTask(task) {
        try { localStorage.setItem(this._SB_TASK_KEY, JSON.stringify(task)); } catch (e) {}
    },
    _loadGenTask() {
        try {
            const raw = localStorage.getItem(this._SB_TASK_KEY);
            if (!raw) return null;
            const t = JSON.parse(raw);
            // 超过 15 分钟视为过期
            if (!t || !t.taskId || Date.now() - (t.start || 0) > 900000) { this._clearGenTask(); return null; }
            return t;
        } catch (e) { return null; }
    },
    _clearGenTask() { try { localStorage.removeItem(this._SB_TASK_KEY); } catch (e) {} },

    // ===== 分镜生成：常驻结果横幅（成功/失败，手动叉掉或下次生成覆盖）=====
    _saveGenResult(r) {
        try { localStorage.setItem(this._SB_RESULT_KEY, JSON.stringify(r)); } catch (e) {}
    },
    _loadGenResult() {
        try { return JSON.parse(localStorage.getItem(this._SB_RESULT_KEY) || 'null'); } catch (e) { return null; }
    },
    dismissGenResult() {
        try { localStorage.removeItem(this._SB_RESULT_KEY); } catch (e) {}
        const el = document.getElementById('sbGenResultBanner');
        if (el) el.remove();
    },
    _genResultBannerHtml() {
        const r = this._loadGenResult();
        if (!r || !r.text) return '';
        const cls = r.ok ? 'ok' : 'err';
        const icon = r.ok ? '✅' : '❌';
        return `<div class="gen-result-banner ${cls}" id="sbGenResultBanner">
            <span class="gen-result-icon">${icon}</span>
            <span class="gen-result-text">${this.esc(r.text)}</span>
            <button class="gen-result-close" title="关闭" onclick="StoryboardModule.dismissGenResult()">×</button>
        </div>`;
    },

    // 「✨ 智能生成分镜」主按钮：生成中置灰转圈并每秒刷新已用秒数（任务在后台跑，刷新/切 tab 仍保持）
    _startGenMainTimer() {
        this._stopGenMainTimer();
        const tick = () => {
            const t = this._loadGenTask();
            const timer = document.getElementById('sbGenMainTimer');
            if (!t || !timer) return;
            const sec = Math.round((Date.now() - (t.start || Date.now())) / 1000);
            timer.textContent = `智能生成分镜中 ${sec}s`;
        };
        tick();
        this._genMainTimer = setInterval(tick, 1000);
    },
    _stopGenMainTimer() {
        if (this._genMainTimer) { clearInterval(this._genMainTimer); this._genMainTimer = null; }
    },

    // ⏹ 停止：仅前端停止跟踪本次生成（清任务、停轮询、停计时器，按钮恢复可点）。
    // 注意：后台 CC 子进程可能仍在运行（无后端取消接口），但前端不再等待其结果。
    async stopGenerate() {
        if (!this._loadGenTask()) return;
        const ok = await App.confirm({
            title: '⏹ 停止生成',
            message: '停止跟踪本次生成？\n\n前端会立即恢复「智能生成分镜」按钮；后台任务可能仍在运行，但其结果将不再自动写入。',
            okText: '停止跟踪',
            cancelText: '继续等待',
            danger: true,
        });
        if (!ok) return;
        this._genPolling = false;
        this._clearGenTask();
        this._stopGenMainTimer();
        // 关闭可能开着的执行弹窗
        const out = document.getElementById('sbGenOutput');
        if (out) App.closeModal();
        App.showToast('⏹ 已停止跟踪本次生成', 'info');
        if (this.projectId) this.render(this.projectId);
    },

    // 📥 上传 JSON：触发隐藏的文件选择框
    importGroupsFromFile() {
        const input = document.getElementById('sbImportJson');
        if (input) { input.value = ''; input.click(); }
    },

    // 选择文件上传后回调
    onImportJsonFile(event) {
        const file = event && event.target && event.target.files && event.target.files[0];
        if (file) this._readJsonFile(file);
    },

    // 读取一个 File 为文本并交给解析器（上传 / 拖放共用）
    _readJsonFile(file) {
        if (!/\.json$/i.test(file.name) && file.type && file.type.indexOf('json') < 0) {
            App.showToast('⚠️ 请拖入 .json 文件', 'error');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => this._parseAndImportJson(reader.result);
        reader.onerror = () => App.showToast('❌ 文件读取失败', 'error');
        reader.readAsText(file);
    },

    // 解析分镜 JSON 文本（与智能生成结果同构：含 person / 分镜 字段）并导入为分镜组。
    // 解析失败 / 字段缺失都会给出明确提示。
    _parseAndImportJson(text) {
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            App.showToast('❌ JSON 解析失败：文件不是合法的 JSON', 'error');
            return;
        }
        // 兼容多种字段命名：分镜 / storyboards；person / persons / 人物
        const storyboards = data['分镜'] || data.storyboards || data.storyboard || null;
        const person = data.person || data.persons || data['人物'] || {};
        if (!storyboards || typeof storyboards !== 'object' || !Object.keys(storyboards).length) {
            App.showToast('⚠️ 未识别到分镜数据：JSON 需包含『分镜』（或 storyboards）字段', 'error');
            return;
        }
        try {
            const stat = this._importGroups(person, storyboards) || {};
            App.showToast(`✅ 已导入：${stat.groupCount || 0} 组四宫格 · 共 ${stat.shots || 0} 个分镜`, 'success');
            if (this.projectId) this.render(this.projectId);
        } catch (e) {
            console.error(e);
            App.showToast('❌ 导入失败：' + (e.message || '分镜结构异常'), 'error');
        }
    },

    // 📤 导出剧本 / 人物 / 道具 / 场景为 JSON 文件，供另一台机器导入或 CC 生成分镜时复用
    exportContextJson() {
        const p = Storage.getProject(this.projectId) || {};
        const payload = {
            exportedAt: new Date().toISOString(),
            project: p.name || p.title || '',
            script: p.script || '',
            characters: (p.characters || []).map(c => ({ name: c.name, description: c.description, voice: c.voice })),
            props: (p.props || []).map(x => ({ name: x.name, description: x.description })),
            scenes: (p.scenes || []).map(x => ({ name: x.name, description: x.description })),
        };
        const total = payload.characters.length + payload.props.length + payload.scenes.length;
        if (!payload.script && !total) { App.showToast('当前没有可导出的剧本 / 人物 / 道具 / 场景', 'info'); return; }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safeName = (payload.project || 'project').replace(/[\\/:*?"<>|]/g, '_');
        a.href = url;
        a.download = `${safeName}_素材上下文_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        App.showToast(`📤 已导出：人物 ${payload.characters.length} · 道具 ${payload.props.length} · 场景 ${payload.scenes.length}`, 'success');
    },

    // 拖放区：拖入 .json 自动解析导入
    _bindDropZone() {
        const zone = document.getElementById('sbDropZone');
        if (!zone || zone._bound) return;
        zone._bound = true;
        const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
        ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => { stop(e); zone.classList.add('sb-drop-over'); }));
        ['dragleave', 'dragend'].forEach(ev => zone.addEventListener(ev, (e) => { stop(e); zone.classList.remove('sb-drop-over'); }));
        zone.addEventListener('drop', (e) => {
            stop(e);
            zone.classList.remove('sb-drop-over');
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) { App.showToast('⚠️ 未检测到文件', 'error'); return; }
            this._readJsonFile(file);
        });
    },

    // 执行中弹窗（与「提取人物/道具/场景」相同的 cc-terminal 风格）
    _showGenRunningModal() {
        const mc = document.getElementById('modalContent');
        if (!mc) return;
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title"><span class="cc-live-dot"></span> Claude Code 执行中…</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                <div class="extract-progress-tip" id="sbGenTip">正在阅读剧本并拆分四宫格分镜，这可能需要几分钟。可关闭本窗口，任务会在后台继续。</div>
                <div class="cc-terminal">
                    <div class="cc-terminal-bar"><span class="cc-dot r"></span><span class="cc-dot y"></span><span class="cc-dot g"></span><span class="cc-terminal-title">claude-code · storyboard</span></div>
                    <div id="sbGenOutput" class="cc-terminal-body">$ 正在调用 Claude Code，请稍候<span class="cc-cursor">▋</span></div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">后台运行</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    // 顶部横幅：生成中状态已由「✨ 智能生成分镜」主按钮的转圈+秒数表达，
    // 这里不再额外渲染横幅（避免重复的大转圈，保持页面简洁）。
    _renderGenBanner(state) {
        const el = document.getElementById('sbGenBanner');
        if (el) el.innerHTML = '';
    },

    // 恢复进行中的 CC 分镜任务（render 时调用）
    _resumeGenTask() {
        const t = this._loadGenTask();
        if (!t) { this._renderGenBanner(false); this._stopGenMainTimer(); return; }
        this._renderGenBanner(true);
        this._startGenMainTimer();   // 主按钮置灰转圈 + 每秒刷新已用秒数（DOM 已由 render 重建）
        if (!this._genPolling) this._pollGenTask();
    },

    // 轮询 CC 分镜任务（全局唯一，结果回写 + toast，弹窗开则同步刷新终端文本）
    async _pollGenTask() {
        const t = this._loadGenTask();
        if (!t) { this._genPolling = false; this._renderGenBanner(false); return; }
        this._genPolling = true;
        try {
            const r = await API.post('/api/sb_task', { task_id: t.taskId });
            const out = document.getElementById('sbGenOutput');
            if (r.status === 'done') {
                this._genPolling = false; this._clearGenTask(); this._stopGenMainTimer();
                const result = r.result || {};
                if (result.storyboards && Object.keys(result.storyboards).length) {
                    const stat = this._importGroups(result.person || {}, result.storyboards) || {};
                    this._saveGenResult({ ok: true, text: `分镜生成完成：本次生成 ${stat.groupCount || 0} 组四宫格 · 共 ${stat.shots || 0} 个分镜`, ts: Date.now() });
                } else {
                    this._saveGenResult({ ok: false, text: '未解析到分镜数据（请检查 Claude 输出 / 调整提示词）', ts: Date.now() });
                }
                // 关闭可能开着的执行弹窗，刷新列表
                if (out) App.closeModal();
                if (this.projectId) this.render(this.projectId);
                return;
            }
            if (r.status === 'error' || r.status === 'missing') {
                this._genPolling = false; this._clearGenTask(); this._stopGenMainTimer();
                const msg = r.status === 'missing' ? '任务已失效（服务可能已重启）' : (r.error || '生成失败');
                this._saveGenResult({ ok: false, text: '分镜生成失败：' + msg, ts: Date.now() });
                if (out) { out.textContent = '$ ' + msg; }
                this._renderGenBanner(false);
                if (this.projectId) this.render(this.projectId);   // 恢复主按钮为可点状态
                return;
            }
            // running / pending：更新终端文本
            if (out) {
                out.innerHTML = `$ Claude ${r.status === 'running' ? '正在拆分分镜' : '排队中'}…<span class="cc-cursor">▋</span>`;
            }
            setTimeout(() => this._pollGenTask(), 2000);
        } catch (e) {
            setTimeout(() => this._pollGenTask(), 3500);  // 网络抖动退避
        }
    },

    // 把 CC 返回的分镜结构存入项目。
    // 优先读取 ref_assets 字段（与 nano 中的 @图N 一一对应），
    // 这样后续生成四宫格时就严格按此顺序拼人物/道具/场景参考图。
    _importGroups(person, storyboards) {
        const groups = [];
        // 分镜键可能是 "1","2"... 按数字排序
        const keys = Object.keys(storyboards).sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));
        for (const k of keys) {
            const sb = storyboards[k] || {};
            const refs = Array.isArray(sb.ref_assets) ? sb.ref_assets.map((r, i) => ({
                idx: parseInt(r.idx) || (i + 1),
                type: ['character', 'prop', 'scene'].includes(r.type) ? r.type : 'character',
                name: (r.name || '').trim(),
            })).filter(r => r.name) : [];
            groups.push({
                id: Storage._uid(),
                idx: parseInt(k) || groups.length + 1,
                globalPrompt: sb.global_prompt || '',
                localPrompts: Array.isArray(sb.local_prompts) ? sb.local_prompts.slice(0, 4) : ['', '', '', ''],
                nanoPrompt: sb.nano_banana_prompt || '',
                refAssets: refs,
                dialogues: Array.isArray(sb.dialogues) ? sb.dialogues : [],
                negative: sb.negative_prompt || '',
                transition: (sb.transition || 'cut').toLowerCase().includes('smooth') ? 'smooth'
                          : ((sb.transition || '').toLowerCase().includes('fade') ? 'fade' : 'cut'),
                fourGridImageId: null,
                panelImages: [null, null, null, null],   // mediaLibrary id（切分后的 4 张）
                panelAudios: [null, null, null, null],    // mediaLibrary id（4 句配音）
                selected: false,                          // CC 生成完默认不选中（单分镜「合成视频」不勾）
                panelSelected: [false, false, false, false], // 四宫格每个 panel 默认不选中
            });
        }
        Storage.updateProject(this.projectId, { storyboardGroups: groups, storyboardPersons: person });
        // 统计本次生成量：四宫格每组 4 个分镜（panel）
        const shots = groups.reduce((n, g) => n + (g.single ? 1 : 4), 0);
        return { groupCount: groups.length, shots };
    },

    // 折叠/展开本组四宫格图像提示词（nano）
    toggleNano(gid) {
        this._nanoOpen[gid] = !this._nanoOpen[gid];
        this.render(this.projectId);
    },

    // ============================================================
    // ② 生成四宫格（gpt-image-2 编辑，多参考图）
    //    入口：弹出"生成配置弹窗"——
    //      ① 可选 API 分组 / 模型 / 尺寸
    //      ② 可编辑 nano 提示词
    //      ③ 按索引列出本次将作为参考的图（人物 / 道具 / 场景，缺图标红、可就地上传）
    //    点"开始生成" → _submitFourGrid 真正提交后端 → 进度弹窗 + 列表行计时
    // ============================================================
    async genFourGrid(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        // 已在生成中：直接复用计时弹窗
        if (this._polls['fg_' + gid]) { this._showFgProgressModal(gid); return; }

        this._showFgConfigModal(gid);
    },

    // 生成配置弹窗（仿人物生成图：可选 API/模型/尺寸 + 提示词 + 参考图清单）
    _showFgConfigModal(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const s = Storage.getSettings();
        const groups = s.imageApiGroups || [];
        const defs = s.imageDefaults || {};
        if (!groups.length) { App.showToast('请先在设置中配置图像 API', 'error'); return; }
        const activeGroup = groups.find(gr => gr.id === (defs.activeGroupId || groups[0].id)) || groups[0];
        this._genGroups = groups;

        const models = activeGroup.models || ['gpt-image-2'];
        // 默认选含 "image" 的模型（gpt-image-2 优先），否则用第一项
        const defModel = models.find(m => /image/i.test(m)) || models[0];

        const assets = this._collectRefAssets(g);
        const assetRows = this._renderFgAssetRows(gid, assets);
        const missCount = assets.filter(a => a.missing).length;

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🎨 生成四宫格 · 第 ${this._groupIndex(gid) + 1} 组</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                <div class="form-row sb-fg-cfg-row">
                    <div class="form-col"><label class="form-label">API 分组</label>
                        <select class="form-input" id="fgGroup" onchange="StoryboardModule._onFgGroupChange()">
                            ${groups.map(gr => `<option value="${gr.id}" ${gr.id === activeGroup.id ? 'selected' : ''}>${this.esc(gr.name)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-col"><label class="form-label">模型</label>
                        <select class="form-input" id="fgModel">
                            ${models.map(m => `<option value="${m}" ${m === defModel ? 'selected' : ''}>${m}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-col"><label class="form-label">尺寸</label>
                        <select class="form-input" id="fgSize">
                            ${this._sizeOpts(defs.size || 'auto')}
                        </select>
                    </div>
                    <div class="form-col"><label class="form-label">画质</label>
                        <select class="form-input" id="fgQuality">
                            ${['auto', 'low', 'medium', 'high'].map(v => `<option value="${v}" ${v === (defs.quality || 'auto') ? 'selected' : ''}>${v}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <p class="form-hint" style="margin:-0.3rem 0 0.2rem">尺寸 / 画质默认取自设置，可在此临时调整。</p>
                <div class="form-group">
                    <label class="form-label">四宫格生成提示词（nano，可改）</label>
                    <textarea class="form-textarea" id="fgPrompt" style="min-height:120px" onchange="StoryboardModule._saveFgPrompt('${gid}', this.value)">${this.esc(g.nanoPrompt || g.globalPrompt || '')}</textarea>
                    <p class="form-hint" style="margin-top:0.3rem">提示词开头应按 <b>@图1=…、@图2=…</b> 顺序声明参考图，下方列表的索引就是接口收到的顺序。</p>
                </div>
                <div class="form-group">
                    <div class="meta-header">
                        <span class="meta-label">📷 参考图清单（${assets.length} 张${missCount ? ` · <span style="color:var(--err)">缺 ${missCount}</span>` : ''}）</span>
                    </div>
                    <div class="sb-fg-refs" id="fgRefList">${assetRows}</div>
                </div>
                <div id="fgConfigStatus"></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" id="fgGoBtn" onclick="StoryboardModule._submitFourGrid('${gid}')">${missCount ? `⚠️ 缺 ${missCount} 张·仍要生成` : '▶ 开始生成'}</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    // 尺寸下拉选项（与设置页 sizeLabelOpts 保持一致）
    _sizeOpts(sel) {
        const sizes = [
            { v: 'auto', l: 'auto 默认' },
            { v: '1024x1024', l: '1024x1024 正方形 1:1' },
            { v: '1536x1024', l: '1536x1024 横屏 3:2' },
            { v: '1024x1536', l: '1024x1536 竖屏 2:3' },
            { v: '2048x2048', l: '2048x2048 2K正方形 1:1' },
            { v: '2048x1152', l: '2048x1152 2K横屏 16:9' },
            { v: '3840x2160', l: '3840x2160 4K横屏 16:9' },
            { v: '2160x3840', l: '2160x3840 4K竖屏 9:16' }
        ];
        return sizes.map(s => `<option value="${s.v}" ${s.v === sel ? 'selected' : ''}>${s.l}</option>`).join('');
    },

    // 四宫格错误小标签（点击查看完整错误，× 可关闭）
    _fgErrorTag(msg, gid) {
        const full = encodeURIComponent(String(msg || ''));
        const brief = String(msg || '').replace(/\s+/g, ' ').slice(0, 14);
        return `<div class="gen-err-tag" title="点击查看完整错误" onclick="StoryboardModule.showFgError('${full}')">`
            + `<span class="gen-err-txt">⚠️ ${this.esc(brief)}${String(msg).length > 14 ? '…' : ''}</span>`
            + (gid ? `<span class="gen-err-x" title="忽略" onclick="event.stopPropagation();StoryboardModule.clearFgError('${gid}')">✕</span>` : '')
            + `</div>`;
    },

    showFgError(enc) {
        const msg = decodeURIComponent(enc || '');
        App.confirm({ title: '❌ 四宫格生成失败', message: msg || '未知错误', okText: '知道了', cancelText: '关闭' });
    },

    // 弹窗里改了四宫格提示词 → 立即写回 storage 并重绘外部列表（保持内外同步）
    _saveFgPrompt(gid, val) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const v = (val || '').trim();
        if (g.nanoPrompt === v) return;
        g.nanoPrompt = v;
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);
    },

    _onFgGroupChange() {
        const gid = document.getElementById('fgGroup').value;
        const group = (this._genGroups || []).find(g => g.id === gid);
        const sel = document.getElementById('fgModel');
        const models = (group && group.models) ? group.models : ['gpt-image-2'];
        const defModel = models.find(m => /image/i.test(m)) || models[0];
        sel.innerHTML = models.map(m => `<option value="${m}" ${m === defModel ? 'selected' : ''}>${m}</option>`).join('');
    },

    _renderFgAssetRows(gid, assets) {
        if (!assets.length) return '<div class="form-hint">未识别到任何参考资产</div>';
        return `<div class="sb-fg-ref-grid">` + assets.map(a => {
            const typeIcon = a.type === 'character' ? '👤' : (a.type === 'prop' ? '🔧' : '🏞️');
            const typeLab = this._typeLabel(a.type);
            const thumb = a.url
                ? `<img src="${a.url}" alt="${this.esc(a.name)}">`
                : `<div class="sb-fg-ref-miss">缺图</div>`;
            const ownerId = a.item ? a.item.id : '';
            const storageType = a.type === 'character' ? 'characters' : (a.type === 'prop' ? 'props' : 'scenes');
            return `<div class="sb-fg-ref-cell ${a.missing ? 'is-miss' : ''}">
                <div class="sb-fg-ref-idx">@图${a.idx}</div>
                <div class="sb-fg-ref-thumb">${thumb}</div>
                <div class="sb-fg-ref-name" title="${this.esc(a.name)}">${typeIcon} ${this.esc(a.name)}</div>
                <div class="sb-fg-ref-type">${typeLab}</div>
                ${a.missing ? `<button class="btn-ghost btn-tiny" ${ownerId ? '' : 'disabled title="该项未在素材库中"'} onclick="StoryboardModule._fgUploadRef('${gid}','${storageType}','${ownerId}')">📁 上传</button>` : ''}
            </div>`;
        }).join('') + `</div>`;
    },

    // 弹窗内点上传：写入素材库后重新打开配置弹窗（参考图清单刷新）
    _fgUploadRef(gid, type, ownerId) {
        if (!ownerId) { App.showToast('请先到对应页面添加该条目', 'error'); return; }
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = async e => {
            const f = e.target.files[0]; if (!f) return;
            const r = new FileReader();
            r.onload = async ev => {
                const data = ev.target.result;
                const dims = await CharacterModule.computeDims(data);
                await Storage.addItemImage(this.projectId, type, ownerId, data, dims);
                App.showToast('✅ 已上传参考图', 'success');
                this._showFgConfigModal(gid);  // 重新渲染配置弹窗
                this.render(this.projectId);
            };
            r.readAsDataURL(f);
        };
        inp.click();
    },

    // 实际提交四宫格生成任务（参考图齐备时）
    async _submitFourGrid(gid) {
        // 从配置弹窗取值（若是从其他地方直接调用 _submitFourGrid，则用默认值兜底）
        const promptEl = document.getElementById('fgPrompt');
        const groupSel = document.getElementById('fgGroup');
        const modelSel = document.getElementById('fgModel');
        const sizeSel = document.getElementById('fgSize');
        const qualitySel = document.getElementById('fgQuality');

        const s = Storage.getSettings();
        const apiGroups = s.imageApiGroups || [];
        const defs = s.imageDefaults || {};
        const activeGroup = (groupSel && apiGroups.find(gr => gr.id === groupSel.value))
            || apiGroups.find(gr => gr.id === (defs.activeGroupId || apiGroups[0] && apiGroups[0].id))
            || apiGroups[0];
        if (!activeGroup) { App.showToast('请先在设置中配置图像 API', 'error'); return; }

        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;

        // 缺参考图时二次确认（允许在缺图情况下继续生成）
        const checkAssets = this._collectRefAssets(g);
        const missing = checkAssets.filter(a => a.missing);
        if (missing.length) {
            const names = missing.map(a => `@图${a.idx} ${a.name}`).join('、');
            const ok = await App.confirm({
                title: '⚠️ 缺少参考图',
                message: `还有 ${missing.length} 张参考图未上传：\n${names}\n\n确定在缺少参考图的情况下继续生成吗？`,
                okText: '仍要生成',
                cancelText: '去上传',
            });
            if (!ok) return;
        }

        // 把用户在弹窗中改过的提示词回写
        if (promptEl) {
            g.nanoPrompt = (promptEl.value || '').trim();
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        }

        // 计时弹窗（仿人物图像生成）
        this._showFgProgressModal(gid, '正在准备参考图…');

        const assets = this._collectRefAssets(g);
        const refB64 = [];
        for (const a of assets) {
            if (!a.url) continue;  // 跳过缺图（缺图允许生成，这里只把有图的传给接口）
            const b64 = await this._urlToB64(a.url);
            if (b64) refB64.push(b64);
        }
        if (!refB64.length) {
            App.showToast('至少需要一张参考图（编辑接口要求），当前一张可用图都没有', 'error');
            this._closeFgProgressModal();
            return;
        }

        this._updFgProgressText(gid, `参考图就绪（${refB64.length} 张）· 正在提交任务…`);

        const submit = await API.post('/api/storyboard/fourgrid', {
            prompt: g.nanoPrompt || g.globalPrompt,
            ref_images: refB64,
            api_url: activeGroup.url,
            api_key: activeGroup.apiKey,
            model: (modelSel && modelSel.value) || (activeGroup.models && activeGroup.models.find(m => /image/i.test(m))) || 'gpt-image-2',
            size: (sizeSel && sizeSel.value) || defs.size || 'auto',
            quality: (qualitySel && qualitySel.value) || defs.quality || 'auto',
        });
        if (!submit.success || !submit.task_id) {
            const pp = Storage.getProject(this.projectId);
            const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
            if (gg) { gg.fourGridError = submit.error || '提交失败'; Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups }); }
            App.showToast(submit.error || '提交失败', 'error');
            this._closeFgProgressModal();
            this.render(this.projectId);
            return;
        }
        // 清除旧错误，启动轮询 + 计时
        {
            const pp = Storage.getProject(this.projectId);
            const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
            if (gg && gg.fourGridError) { gg.fourGridError = ''; Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups }); }
        }
        this._polls['fg_' + gid] = submit.task_id;
        this._saveFgTask(gid, { taskId: submit.task_id, start: Date.now() });
        this._startFgTimer(gid);
        this.render(this.projectId);
        this._showFgProgressModal(gid, '已提交，正在生成四宫格…');
        this._pollFourGrid(gid, submit.task_id);
    },

    // 上传一张本地四宫格图（替代生成），自动切分 4 个面板
    uploadFourGrid(gid) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = async e => {
            const f = e.target.files[0]; if (!f) return;
            const r = new FileReader();
            r.onload = async ev => {
                const data = ev.target.result;
                const dims = await CharacterModule.computeDims(data);
                const entry = await Storage._addMedia(this.projectId, 'image', 'storyboards', gid, data, null, dims);
                const pp = Storage.getProject(this.projectId);
                const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
                if (gg) {
                    gg.fourGridImageId = entry.id;
                    gg.fourGridError = '';
                    await this._splitFourGrid(gg, data);
                    Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups });
                }
                App.showToast('✅ 已上传并切分四宫格', 'success');
                this.render(this.projectId);
            };
            r.readAsDataURL(f);
        };
        inp.click();
    },

    // ===== 四宫格生成进度弹窗（仿人物图像生成：s 数 + 进度条）=====
    _showFgProgressModal(gid, hint) {
        const mc = document.getElementById('modalContent');
        if (!mc) return;
        const start = (this._loadFgTasks()[gid] || {}).start || Date.now();
        const sec = Math.max(0, Math.round((Date.now() - start) / 1000));
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🎨 生成四宫格</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                <div class="sb-fg-prog">
                    <div class="sb-spinner"></div>
                    <div>
                        <div class="sb-fg-prog-title">第 <b>${this._groupIndex(gid) + 1}</b> 组四宫格生成中</div>
                        <div class="sb-fg-prog-sub" id="fgProgText_${gid}">${this.esc(hint || '正在调用 gpt-image-2…')}</div>
                        <div class="sb-fg-prog-timer">⏱️ <span id="fgProgSec_${gid}">${sec}</span>s</div>
                    </div>
                </div>
                <div class="gen-progress" style="margin-top:0.8rem"><div class="gen-progress-bar" id="fgProgBar_${gid}" style="width:${Math.min(sec * 1.5, 90)}%"></div></div>
                <p class="form-hint" style="margin-top:0.8rem">生成通常需 30~120 秒。可关闭本窗口，任务在后台继续，刷新页面也不会丢失。</p>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">后台运行</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    _updFgProgressText(gid, text) {
        const el = document.getElementById('fgProgText_' + gid);
        if (el) el.textContent = text;
    },
    _closeFgProgressModal() { App.closeModal(); },
    _groupIndex(gid) {
        const p = Storage.getProject(this.projectId);
        return (p.storyboardGroups || []).findIndex(x => x.id === gid);
    },

    // 四宫格生成秒数计时器：1s 更新一次按钮、缩略图占位、弹窗文本
    _startFgTimer(gid) {
        this._stopFgTimer(gid);
        this._fgStart[gid] = Date.now();
        this._fgTimers[gid] = setInterval(() => {
            const sec = Math.round((Date.now() - this._fgStart[gid]) / 1000);
            const btn = document.getElementById('fgBtn_' + gid);
            if (btn) btn.textContent = `⏳ ${sec}s`;
            const ph = document.getElementById('fgTimer_' + gid);
            if (ph) ph.textContent = `生成中 ${sec}s`;
            const ps = document.getElementById('fgProgSec_' + gid);
            if (ps) ps.textContent = sec;
            const bar = document.getElementById('fgProgBar_' + gid);
            if (bar) bar.style.width = Math.min(sec * 1.5, 95) + '%';
        }, 1000);
    },
    _stopFgTimer(gid) {
        if (this._fgTimers[gid]) { clearInterval(this._fgTimers[gid]); delete this._fgTimers[gid]; }
        delete this._fgStart[gid];
    },

    // 轮询四宫格任务：成功 → 落库 + 切分；失败 → fourGridError 落库（不占空图）
    async _pollFourGrid(gid, taskId) {
        try {
            const result = await this._pollTask(taskId, null);
            delete this._polls['fg_' + gid];
            this._clearFgTask(gid);
            this._stopFgTimer(gid);
            if (result && result.images && result.images[0]) {
                const dataUrl = 'data:image/png;base64,' + result.images[0];
                const dims = await CharacterModule.computeDims(dataUrl);
                const entry = await Storage._addMedia(this.projectId, 'image', 'storyboards', gid, dataUrl, null, dims);
                const pp = Storage.getProject(this.projectId);
                const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
                if (gg) {
                    gg.fourGridImageId = entry.id;
                    gg.fourGridError = '';            // 成功 → 清除错误
                    await this._splitFourGrid(gg, dataUrl);
                    Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups });
                }
                App.showToast('✅ 四宫格已生成并切分', 'success');
                // 如果进度弹窗还开着就关掉
                if (document.getElementById('fgProgSec_' + gid)) App.closeModal();
            } else {
                this._setFgError(gid, '未获取到图像数据');
                App.showToast('四宫格生成失败', 'error');
            }
            this.render(this.projectId);
        } catch (e) {
            delete this._polls['fg_' + gid];
            this._clearFgTask(gid);
            this._stopFgTimer(gid);
            this._setFgError(gid, e.message || '生成失败');
            App.showToast('四宫格生成失败：' + e.message, 'error');
            if (document.getElementById('fgProgSec_' + gid)) App.closeModal();
            this.render(this.projectId);
        }
    },

    _setFgError(gid, msg) {
        const pp = Storage.getProject(this.projectId);
        const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
        if (gg) { gg.fourGridError = msg; Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups }); }
    },

    // ===== 四宫格任务持久化（按项目隔离，刷新可恢复）=====
    _fgTaskKey() { return this._FG_TASK_KEY + ':' + this.projectId; },
    _loadFgTasks() {
        try { return JSON.parse(localStorage.getItem(this._fgTaskKey()) || '{}') || {}; }
        catch (e) { return {}; }
    },
    _saveFgTask(gid, task) {
        const all = this._loadFgTasks(); all[gid] = task;
        try { localStorage.setItem(this._fgTaskKey(), JSON.stringify(all)); } catch (e) {}
    },
    _clearFgTask(gid) {
        const all = this._loadFgTasks(); delete all[gid];
        try { localStorage.setItem(this._fgTaskKey(), JSON.stringify(all)); } catch (e) {}
    },

    // 收集本组参考资产（带索引/类型/名称/缩略图）。
    // 顺序优先级：
    //  ① 若 CC 返回了 ref_assets（带 idx/type/name），严格按其顺序拼图；
    //  ② 否则自动推断：人物(按台词首次出现顺序) → 道具(本组 local/nano 中提到的) → 场景。
    // 返回 [{ idx, type, name, item, mediaId?, url?, missing }]，调用方按 idx 排序后即可送入接口。
    _collectRefAssets(g) {
        const p = Storage.getProject(this.projectId);
        const out = [];
        const seen = new Set();
        const findItem = (type, name) => {
            const list = type === 'character' ? (p.characters || [])
                : (type === 'prop' ? (p.props || []) : (p.scenes || []));
            return list.find(x => (x.name || '').trim() === (name || '').trim());
        };
        const typeToStorage = t => t === 'character' ? 'characters' : (t === 'prop' ? 'props' : 'scenes');
        const push = (type, name) => {
            if (!name) return;
            const key = type + ':' + name;
            if (seen.has(key)) return; seen.add(key);
            const item = findItem(type, name);
            let url = '', mediaId = null, missing = true;
            if (item) {
                const m = Storage.getSelectedMedia(this.projectId, typeToStorage(type), item, 'image');
                if (m) { url = Storage.mediaUrl(m.data); mediaId = m.id; missing = false; }
            }
            out.push({ idx: out.length + 1, type, name, item, mediaId, url, missing });
        };

        // ① 若 CC/Mock 标注了 ref_assets → 按其顺序
        if (Array.isArray(g.refAssets) && g.refAssets.length) {
            g.refAssets.forEach(r => push(r.type || 'character', r.name));
            return out.slice(0, 8);
        }

        // ② 人物：按 dialogues 首次出现顺序
        const charOrder = [];
        (g.dialogues || []).forEach(d => {
            const n = (d && d.character || '').trim();
            if (n && !charOrder.includes(n)) charOrder.push(n);
        });
        if (!charOrder.length) (p.characters || []).slice(0, 3).forEach(c => charOrder.push(c.name));
        charOrder.forEach(n => push('character', n));

        // ③ 道具：扫描本组 nano/global/local 文本里出现过的道具名
        const haystack = [g.nanoPrompt || '', g.globalPrompt || ''].concat(g.localPrompts || []).join(' ');
        (p.props || []).forEach(x => { if (x.name && haystack.includes(x.name)) push('prop', x.name); });
        // 若没匹配上 → 取前 2 个有图道具兜底
        if (!out.some(r => r.type === 'prop')) (p.props || []).slice(0, 2).forEach(x => push('prop', x.name));

        // ④ 场景：扫描文本中出现的，否则取第 1 个
        let sceneAdded = false;
        (p.scenes || []).forEach(x => { if (x.name && haystack.includes(x.name)) { push('scene', x.name); sceneAdded = true; } });
        if (!sceneAdded && (p.scenes || []).length) push('scene', p.scenes[0].name);

        return out.slice(0, 8);
    },

    // 兼容旧接口：返回 url 列表（仅有图的）
    _collectRefImages(g) {
        return this._collectRefAssets(g).filter(r => r.url).map(r => r.url);
    },

    async _urlToB64(url) {
        try {
            const resp = await fetch(url);
            const blob = await resp.blob();
            return await new Promise(res => {
                const r = new FileReader();
                r.onload = () => res((r.result || '').split(',')[1] || '');
                r.onerror = () => res('');
                r.readAsDataURL(blob);
            });
        } catch (e) { return ''; }
    },

    // 前端 canvas 2x2 等分切四宫格 → 存为 4 张 panel 图
    async _splitFourGrid(g, dataUrl) {
        const img = await new Promise((res, rej) => {
            const im = new Image();
            im.onload = () => res(im); im.onerror = rej; im.src = dataUrl;
        });
        const hw = Math.floor(img.naturalWidth / 2);
        const hh = Math.floor(img.naturalHeight / 2);
        const positions = [[0, 0], [hw, 0], [0, hh], [hw, hh]]; // 左上 右上 左下 右下
        const ids = [null, null, null, null];
        for (let i = 0; i < 4; i++) {
            const cv = document.createElement('canvas');
            cv.width = hw; cv.height = hh;
            cv.getContext('2d').drawImage(img, positions[i][0], positions[i][1], hw, hh, 0, 0, hw, hh);
            const panelData = cv.toDataURL('image/png');
            const entry = await Storage._addMedia(this.projectId, 'image', 'storyboards', g.id + '_panel' + i, panelData, null, { w: hw, h: hh });
            ids[i] = entry.id;
        }
        g.panelImages = ids;
    },

    // ============================================================
    // ④ 生成配音（Qwen3 语音克隆，参考音色取自台词归属人物的已有音频）
    // ============================================================
    async genAllAudio(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const dialogues = g.dialogues || [];
        const withText = dialogues.filter(d => d.text && d.text.trim());
        if (!withText.length) { App.showToast('本组没有台词，无需配音', 'info'); return; }

        App.showToast(`开始为 ${withText.length} 句台词配音…`, 'info');
        let done = 0;
        for (let i = 0; i < dialogues.length; i++) {
            const d = dialogues[i];
            if (!d || !d.text || !d.text.trim()) continue;
            const ok = await this._genOneAudio(gid, i, d);
            if (ok) done++;
        }
        App.showToast(done ? `✅ 完成 ${done} 句配音` : '配音失败，请检查参考音色与 ComfyUI', done ? 'success' : 'error');
        this.render(this.projectId);
    },

    // 为某面板的台词生成配音。参考音色 = 该角色人物卡片里已选的音频
    async _genOneAudio(gid, panelIdx, dialogue) {
        const p = Storage.getProject(this.projectId);
        const char = (p.characters || []).find(c => c.name === dialogue.character);
        let refB64 = '', refMime = 'audio/wav';
        if (char) {
            const audio = Storage.getSelectedMedia(this.projectId, 'characters', char, 'audio');
            if (audio) {
                refB64 = await this._urlToB64(Storage.mediaUrl(audio.data));
                refMime = audio.mime || 'audio/wav';
            }
        }
        if (!refB64) {
            App.showToast(`「${dialogue.character || '?'}」缺少参考音色，跳过该句`, 'error');
            return false;
        }
        try {
            const submit = await API.post('/api/storyboard/tts_clone', {
                ref_audio_b64: refB64, ref_audio_mime: refMime,
                text: dialogue.text, ref_text: dialogue.tone || '',
            });
            if (!submit.success || !submit.task_id) throw new Error(submit.error || '提交失败');
            const result = await this._pollTask(submit.task_id, null, 1200);
            if (result && result.audio_base64) {
                const dataUrl = 'data:audio/wav;base64,' + result.audio_base64;
                const entry = await Storage._addMedia(this.projectId, 'audio', 'storyboards', gid + '_audio' + panelIdx, dataUrl, 'audio/wav');
                const pp = Storage.getProject(this.projectId);
                const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
                if (gg) {
                    if (!gg.panelAudios) gg.panelAudios = [null, null, null, null];
                    gg.panelAudios[panelIdx] = entry.id;
                    Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups });
                }
                return true;
            }
            throw new Error('未产出音频');
        } catch (e) {
            App.showToast(`「${dialogue.character || '?'}」配音失败：${e.message}`, 'error');
            return false;
        }
    },

    // ===== 面板配音弹窗（仿人物 TTS）：可改台词/语气，听匹配人物的原始音色，显示配音历史 =====
    openAudioModal(gid, panelIdx) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const d = (g.dialogues || [])[panelIdx] || {};
        const char = (p.characters || []).find(c => c.name === d.character);
        const refAudio = char ? Storage.getSelectedMedia(this.projectId, 'characters', char, 'audio') : null;
        const refUrl = refAudio ? Storage.mediaUrl(refAudio.data) : '';
        const curAudId = (g.panelAudios || [])[panelIdx];
        const curAud = curAudId ? Storage.getMediaById(this.projectId, curAudId) : null;
        const curUrl = curAud ? Storage.mediaUrl(curAud.data) : '';
        const histList = Storage.getMediaForItem(this.projectId, 'storyboards', gid + '_audio' + panelIdx).filter(m => m.type === 'audio');
        const charOptions = (p.characters || []).map(c => `<option value="${this.esc(c.name)}" ${c.name === d.character ? 'selected' : ''}>${this.esc(c.name)}</option>`).join('');

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header">
                <h2 class="modal-title">🔊 配音 · 第 ${this._groupIndex(gid) + 1} 组 · 面板 ${panelIdx + 1}</h2>
                <button class="modal-close" onclick="App.closeModal()">×</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-col">
                        <label class="form-label">说话人</label>
                        <select class="form-input" id="saChar">
                            <option value="">— 不指定 —</option>
                            ${charOptions}
                        </select>
                    </div>
                    <div class="form-col">
                        <label class="form-label">语气 / 风格</label>
                        <input class="form-input" id="saTone" value="${this.esc(d.tone || '')}" placeholder="例如：低沉、温柔、激动">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">台词文本</label>
                    <textarea class="form-textarea" id="saText" style="min-height:72px" placeholder="本面板要说的话">${this.esc(d.text || '')}</textarea>
                </div>
                <div class="sb-audio-ref">
                    <span class="sb-audio-ref-label">参考音色 ${char ? `· ${this.esc(char.name)}` : ''}</span>
                    ${refUrl
                        ? `<audio controls preload="none" src="${refUrl}"></audio>`
                        : (char
                            ? `<span class="sb-audio-ref-miss">⚠️ 该人物尚无音色，请先到人物页生成音频</span>`
                            : `<span class="sb-audio-ref-miss">请先选择说话人</span>`)}
                </div>
                ${curUrl ? `<div class="sb-audio-ref"><span class="sb-audio-ref-label">当前配音</span><audio controls preload="none" src="${curUrl}"></audio></div>` : ''}
                <div id="saResult" style="margin-top:0.6rem"></div>
                ${histList.length >= 1 ? `
                    <details class="sb-audio-hist-block" open>
                        <summary>配音历史（${histList.length} 条）</summary>
                        <div class="audio-history-list">${this._renderAudioHistItems(gid, panelIdx, histList, curAudId)}</div>
                    </details>` : ''}
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" id="saCloseBtn" onclick="App.closeModal()">关闭</button>
                <button class="btn-primary" id="saGenBtn" onclick="StoryboardModule.doGenAudioForPanel('${gid}',${panelIdx})">▶ 生成配音</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    _renderAudioHistItems(gid, panelIdx, list, curId) {
        return list.map((a, idx) => {
            const isCur = a.id === curId;
            return `<div class="audio-history-item ${isCur ? 'selected' : ''}">
                <div class="audio-wave-icon"><span></span><span></span><span></span><span></span></div>
                <div class="audio-history-meta">
                    <div class="audio-history-title">配音 #${idx + 1} ${isCur ? '<span class="audio-cur-tag">当前</span>' : ''}</div>
                    <div class="audio-history-time">${new Date(a.createdAt).toLocaleString('zh-CN')}</div>
                </div>
                <audio id="sbHa_${a.id}" src="${Storage.mediaUrl(a.data)}" style="display:none"></audio>
                <div class="audio-history-actions">
                    <button class="btn-play audio-play-btn" id="sbHp_${a.id}" onclick="StoryboardModule.playHistAudio('${a.id}')">▶</button>
                    <button class="gallery-select-btn" title="设为当前" onclick="StoryboardModule.selectPanelAudio('${gid}',${panelIdx},'${a.id}')">✓</button>
                    <button class="gallery-delete-btn" title="删除" onclick="StoryboardModule.deletePanelAudio('${gid}',${panelIdx},'${a.id}')">×</button>
                </div>
            </div>`;
        }).join('');
    },

    playHistAudio(aid) {
        const a = document.getElementById('sbHa_' + aid);
        const b = document.getElementById('sbHp_' + aid);
        if (!a || !b) return;
        a.onended = () => { b.textContent = '▶'; this._curHistAudio = null; };
        if (a.paused) {
            if (this._curHistAudio && this._curHistAudio !== a) {
                this._curHistAudio.pause();
                const prev = document.getElementById('sbHp_' + this._curHistAudio._aid);
                if (prev) prev.textContent = '▶';
            }
            a.play(); a._aid = aid; this._curHistAudio = a; b.textContent = '⏸';
        } else {
            a.pause(); b.textContent = '▶'; this._curHistAudio = null;
        }
    },

    // 从历史中选一条为当前
    selectPanelAudio(gid, panelIdx, mediaId) {
        const pp = Storage.getProject(this.projectId);
        const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
        if (!gg) return;
        if (!gg.panelAudios) gg.panelAudios = [null, null, null, null];
        gg.panelAudios[panelIdx] = parseInt(mediaId);
        Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups });
        App.showToast('已设为当前配音', 'success');
        this.openAudioModal(gid, panelIdx);
        this.render(this.projectId);
    },

    async deletePanelAudio(gid, panelIdx, mediaId) {
        const ok = await App.confirm({
            title: '删除配音',
            message: '确定删除这条配音历史？删除后不可恢复。',
            okText: '删除',
            cancelText: '取消',
            danger: true,
        });
        if (!ok) return;
        const mid = parseInt(mediaId);
        Storage.deleteMediaItem(this.projectId, mid);
        const pp = Storage.getProject(this.projectId);
        const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
        if (gg && gg.panelAudios && gg.panelAudios[panelIdx] === mid) {
            // 当前被删，回退到最近一条历史，否则置空
            const remain = Storage.getMediaForItem(this.projectId, 'storyboards', gid + '_audio' + panelIdx).filter(m => m.type === 'audio');
            gg.panelAudios[panelIdx] = remain.length ? remain[remain.length - 1].id : null;
            Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups });
        }
        App.showToast('已删除', 'success');
        this.openAudioModal(gid, panelIdx);
        this.render(this.projectId);
    },

    // 列表行的"📜 历史"按钮直接打开配音弹窗（聚焦在历史区）
    showAudioHistory(gid, panelIdx) { this.openAudioModal(gid, panelIdx); },

    // 弹窗内点「生成配音」：取弹窗当前输入，调用后端，带计时（按钮 ⏳ Ns），弹窗可关闭后台继续
    async doGenAudioForPanel(gid, panelIdx) {
        const charName = (document.getElementById('saChar') || {}).value || '';
        const tone = (document.getElementById('saTone') || {}).value || '';
        const text = ((document.getElementById('saText') || {}).value || '').trim();
        if (!text) { App.showToast('请输入台词文本', 'error'); return; }

        // 同步回 dialogue（保证关闭弹窗后下次打开能记住）
        const pp0 = Storage.getProject(this.projectId);
        const gg0 = (pp0.storyboardGroups || []).find(x => x.id === gid);
        if (gg0) {
            if (!gg0.dialogues) gg0.dialogues = [];
            const dl = gg0.dialogues[panelIdx] || { panel: panelIdx + 1 };
            dl.character = charName; dl.tone = tone; dl.text = text;
            gg0.dialogues[panelIdx] = dl;
            Storage.updateProject(this.projectId, { storyboardGroups: pp0.storyboardGroups });
        }

        // 参考音色
        const p = Storage.getProject(this.projectId);
        const char = (p.characters || []).find(c => c.name === charName);
        if (!char) { App.showToast('请选择说话人', 'error'); return; }
        const refAudio = Storage.getSelectedMedia(this.projectId, 'characters', char, 'audio');
        if (!refAudio) { App.showToast(`「${char.name}」尚未生成音色，请先到人物页生成`, 'error'); return; }
        const refB64 = await this._urlToB64(Storage.mediaUrl(refAudio.data));
        const refMime = refAudio.mime || 'audio/wav';

        const key = gid + ':' + panelIdx;
        const genBtn = document.getElementById('saGenBtn');
        const resEl = document.getElementById('saResult');
        if (genBtn) { genBtn.disabled = true; genBtn.textContent = '⏳ 0s'; }
        if (resEl) resEl.innerHTML = '<div class="sb-cc-running"><div class="sb-spinner"></div> 正在通过 ComfyUI 语音克隆生成配音…</div>';
        this._audioTasks[key] = Date.now();
        this.render(this.projectId); // 列表行按钮也变成 ⏳ Ns
        // 计时
        const intv = setInterval(() => {
            const sec = Math.round((Date.now() - this._audioTasks[key]) / 1000);
            if (genBtn) genBtn.textContent = `⏳ ${sec}s`;
            const rowBtn = document.getElementById('sbA_' + gid + '_' + panelIdx);
            if (rowBtn) rowBtn.textContent = `⏳ ${sec}s`;
        }, 1000);

        try {
            const submit = await API.post('/api/storyboard/tts_clone', {
                ref_audio_b64: refB64, ref_audio_mime: refMime,
                text, ref_text: tone,
            });
            if (!submit.success || !submit.task_id) throw new Error(submit.error || '提交失败');
            const result = await this._pollTask(submit.task_id, null, 1200);
            clearInterval(intv);
            delete this._audioTasks[key];
            if (!result || !result.audio_base64) throw new Error('未产出音频');
            const dataUrl = 'data:audio/wav;base64,' + result.audio_base64;
            const entry = await Storage._addMedia(this.projectId, 'audio', 'storyboards', gid + '_audio' + panelIdx, dataUrl, 'audio/wav');
            const pp = Storage.getProject(this.projectId);
            const gg = (pp.storyboardGroups || []).find(x => x.id === gid);
            if (gg) {
                if (!gg.panelAudios) gg.panelAudios = [null, null, null, null];
                gg.panelAudios[panelIdx] = entry.id;
                Storage.updateProject(this.projectId, { storyboardGroups: pp.storyboardGroups });
            }
            App.showToast('✅ 配音已生成', 'success');
            // 弹窗仍开着就重新渲染（带新的当前+历史）
            if (document.getElementById('saText')) this.openAudioModal(gid, panelIdx);
            this.render(this.projectId);
        } catch (e) {
            clearInterval(intv);
            delete this._audioTasks[key];
            if (genBtn) { genBtn.disabled = false; genBtn.textContent = '▶ 重试'; }
            if (resEl) resEl.innerHTML = `<div class="sb-err">❌ ${this.esc(e.message)}</div>`;
            this.render(this.projectId);
        }
    },

    // ============================================================
    // 编辑 / 删除四宫格组
    // ============================================================
    editGroup(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const idx = (p.storyboardGroups || []).findIndex(x => x.id === gid);
        const dlg = g.dialogues || [];
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">✏️ 编辑第 ${idx + 1} 组分镜</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">四宫格提示词 nano_banana_prompt</label>
                    <textarea class="form-textarea" id="egNano" style="min-height:90px">${this.esc(g.nanoPrompt)}</textarea>
                </div>
                ${[0, 1, 2, 3].map(i => `
                    <div class="sb-edit-panel">
                        <div class="sb-edit-panel-title">面板 ${i + 1}</div>
                        <label class="form-label-sm">local 提示词</label>
                        <textarea class="form-textarea" id="egLocal${i}" style="min-height:48px">${this.esc((g.localPrompts || [])[i] || '')}</textarea>
                        <div class="form-row">
                            <div class="form-col"><label class="form-label-sm">说话人</label><input class="form-input" id="egChar${i}" value="${this.esc((dlg[i] || {}).character || '')}" list="egCharList"></div>
                            <div class="form-col"><label class="form-label-sm">语气</label><input class="form-input" id="egTone${i}" value="${this.esc((dlg[i] || {}).tone || '')}"></div>
                        </div>
                        <label class="form-label-sm">台词</label>
                        <input class="form-input" id="egText${i}" value="${this.esc((dlg[i] || {}).text || '')}">
                    </div>`).join('')}
                <datalist id="egCharList">${(p.characters || []).map(c => `<option value="${this.esc(c.name)}">`).join('')}</datalist>
                <div class="form-group">
                    <label class="form-label">转场（影响 Epsilon）</label>
                    <select class="form-input" id="egTrans">
                        <option value="cut" ${g.transition === 'cut' ? 'selected' : ''}>硬切 cut（Epsilon 0.001，锐利边界）</option>
                        <option value="smooth" ${g.transition === 'smooth' ? 'selected' : ''}>平滑 smooth（Epsilon 0.5）</option>
                        <option value="fade" ${g.transition === 'fade' ? 'selected' : ''}>淡入淡出 fade（Epsilon 0.8）</option>
                    </select>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" onclick="StoryboardModule.saveGroup('${gid}')">保存</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    saveGroup(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        g.nanoPrompt = document.getElementById('egNano').value.trim();
        g.transition = document.getElementById('egTrans').value;
        g.localPrompts = [0, 1, 2, 3].map(i => document.getElementById('egLocal' + i).value.trim());
        g.dialogues = [0, 1, 2, 3].map(i => ({
            panel: i + 1,
            character: document.getElementById('egChar' + i).value.trim(),
            text: document.getElementById('egText' + i).value.trim(),
            tone: document.getElementById('egTone' + i).value.trim(),
        }));
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.closeModal();
        App.showToast('已保存', 'success');
        this.render(this.projectId);
    },

    // 删除分镜（四宫格 / 单分镜通用）：自定义确认弹窗，避免系统 confirm 在某些环境下不弹
    delGroup(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        const label = g && g.single ? '这个单分镜' : '这组四宫格分镜';
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">确认删除</h2></div>
        <div class="modal-body"><p style="text-align:center;padding:1rem">确定要删除${label}吗？此操作不可撤销。</p></div>
        <div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">取消</button>
        <button class="btn-danger" onclick="StoryboardModule.doDelGroup('${gid}')">确认删除</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    doDelGroup(gid) {
        const p = Storage.getProject(this.projectId);
        const groups = (p.storyboardGroups || []).filter(x => x.id !== gid);
        Storage.updateProject(this.projectId, { storyboardGroups: groups });
        App.closeModal();
        App.showToast('已删除', 'success');
        this.render(this.projectId);
    },

    // ============================================================
    // ⑤⑥ 时间轴弹窗 + 导演台视频生成
    // ============================================================
    openTimeline() {
        const p = Storage.getProject(this.projectId);
        const all = (p.storyboardGroups || []);
        const segments = [];
        let skipNoImg = 0;      // 已勾选合成但缺图，被跳过的分镜数
        let firstMeta = null;

        all.forEach((g) => {
            if (g.single) {
                if (g.selected === false) return;        // 未勾选合成 → 不纳入
                if (g.imageId == null) { skipNoImg++; return; }   // 勾选了但没生成图 → 跳过并计数
                if (!firstMeta) firstMeta = g;
                segments.push({
                    uid: Storage._uid(),
                    groupId: g.id, panel: 0, single: true,
                    imageId: g.imageId, audioId: g.audioId,
                    prompt: g.prompt || '',
                    length: 90, trimStart: 0,
                    transition: g.transition || 'cut',
                    dialogue: g.dialogue || {},
                });
                return;
            }
            // 四宫格：逐面板，按 panel 勾选纳入；勾选但无切分图 → 跳过并计数
            const dlg = g.dialogues || [];
            for (let i = 0; i < 4; i++) {
                if (g.panelSelected && g.panelSelected[i] === false) continue;  // 未勾选
                const imgId = (g.panelImages || [])[i];
                if (imgId == null) { skipNoImg++; continue; }                   // 勾选但无图
                const audId = (g.panelAudios || [])[i];
                if (!firstMeta) firstMeta = g;
                segments.push({
                    uid: Storage._uid(),
                    groupId: g.id, panel: i,
                    imageId: imgId, audioId: audId,
                    prompt: (g.localPrompts || [])[i] || g.globalPrompt || '',
                    length: 90, trimStart: 0,
                    transition: g.transition || 'cut',
                    dialogue: dlg[i] || {},
                });
            }
        });

        if (!segments.length) {
            App.showToast(skipNoImg
                ? `已勾选 ${skipNoImg} 个分镜，但都还没生成图像，无法合成。请先「生成」或「上传」图像。`
                : '请先勾选要合成的分镜，并确保对应图像已生成', 'error');
            return;
        }
        if (skipNoImg) {
            App.showToast(`已纳入 ${segments.length} 段；另有 ${skipNoImg} 个勾选的分镜因缺图被跳过。`, 'info');
        }
        const first = firstMeta || {};

        // ===== 构建双轨时间轴模型（图像轨 + 音频轨，各自独立，可自由移位/拉伸/裁剪）=====
        const DEF = 90;            // 默认每段帧数
        const imageClips = [];
        const audioClips = [];
        let cursor = 0;
        segments.forEach(s => {
            const len = s.length || DEF;
            const imgUid = Storage._uid();
            imageClips.push({
                uid: imgUid,
                imageId: s.imageId, prompt: s.prompt || '',
                dialogue: s.dialogue || {}, transition: s.transition || 'cut',
                start: cursor, length: len,
            });
            if (s.audioId != null) {
                // 音频块与对应图像对齐（同 start）；length 先用图像段长度，
                // 待 _loadAudioDurations 探测到真实时长后回填，并把图像段也对齐到音频时长。
                audioClips.push({
                    uid: Storage._uid(),
                    audioId: s.audioId,
                    imgUid,                         // 关联的图像段（初始化对齐用）
                    text: (s.dialogue && s.dialogue.text) || '',  // 台词，clip 上显示
                    start: cursor, length: len, trimStart: 0,
                    audioDurationFrames: 0,         // 加载后回填（裁剪上限 + 初始化对齐）
                });
            }
            cursor += len;
        });

        this._tl = {
            imageClips, audioClips,
            totalFrames: cursor,                 // 视频总长（可调）；超出部分置灰
            fps: this.FPS,
            pxPerFrame: 1.4,                      // 缩放：像素/帧
            globalPrompt: first.globalPrompt || first.prompt || '',
            guideStrength: '1.00',
            epsilon: 0.001,                       // 过渡柔和度（0.001 硬切 ~ 1.0 最柔）
            selectedUid: (imageClips[0] && imageClips[0].uid) || null,  // 预览/编辑当前选中的图像段
            playFrame: 0, playing: false,
        };
        this._renderTimeline();
        this._loadAudioDurations(true);          // 异步回填音频时长，并按时长对齐图音、统一序号
    },

    // 读取各音频块真实时长（秒→帧）。除了用于裁剪上限，还在「初始化对齐」时
    // 把音频块 length 设为真实时长，并让其关联的图像段对齐到同样时长（s 数一致），
    // 然后整体重新紧贴布局、音频跟随对应图像段的 start —— 实现「图音对齐、序号一致」。
    async _loadAudioDurations(alignInit) {
        const tl = this._tl; if (!tl) return;
        for (const a of tl.audioClips) {
            if (a.audioDurationFrames) continue;
            const m = a.audioId != null ? Storage.getMediaById(this.projectId, a.audioId) : null;
            if (!m) continue;
            try {
                const dur = await this._probeAudioDuration(Storage.mediaUrl(m.data));
                a.audioDurationFrames = Math.max(1, Math.round(dur * tl.fps));
                if (alignInit) {
                    // 音频块时长 = 真实时长
                    a.length = a.audioDurationFrames;
                    // 关联图像段时长也对齐到音频时长（图音 s 数一致）
                    const img = a.imgUid ? tl.imageClips.find(c => c.uid === a.imgUid) : null;
                    if (img) img.length = a.audioDurationFrames;
                }
            } catch (e) { /* 忽略 */ }
        }
        if (alignInit) {
            // 图像轨重新紧贴布局；音频跟随各自图像段 start 对齐；总长 = 末段结束
            this._relayoutImages();
            tl.audioClips.forEach(a => {
                const img = a.imgUid ? tl.imageClips.find(c => c.uid === a.imgUid) : null;
                if (img) a.start = img.start;
            });
            const far = tl.imageClips.reduce((mx, c) => Math.max(mx, c.start + c.length), 0);
            if (far > 0) tl.totalFrames = far;
        }
        if (this._tl) this._renderTimeline();
    },

    _probeAudioDuration(url) {
        return new Promise((resolve, reject) => {
            const a = new Audio();
            a.preload = 'metadata';
            a.onloadedmetadata = () => resolve(a.duration || 0);
            a.onerror = () => reject(new Error('audio meta load fail'));
            a.src = url;
        });
    },

    // 图像轨：连续紧贴排布（首尾相接，无缝无叠）。改一段时长或换位后调用，
    // 后续所有图像段的 start 会跟着重新计算（ripple 效果）。
    _relayoutImages() {
        const tl = this._tl; if (!tl) return;
        let cursor = 0;
        tl.imageClips.forEach(c => { c.start = cursor; cursor += c.length; });
    },

    // ====== 可视化双轨时间轴编辑器（仿 LTX Director）======
    _renderTimeline() {
        const tl = this._tl;
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🎬 LTX Director · 时间轴</h2><button class="modal-close" onclick="StoryboardModule.closeTimeline()">×</button></div>
            <div class="modal-body sb-dir-body">
                <div class="sb-dir-toolbar">
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule.tlAddImage()">🖼️ 添加图像</button>
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule.tlAddAudio()">🎵 添加音频</button>
                    <span class="sb-dir-sep"></span>
                    <label class="sb-dir-total">视频总长
                        <input type="number" id="tlTotalSec" min="1" step="0.5" value="${(tl.totalFrames / tl.fps).toFixed(1)}"
                            oninput="StoryboardModule.tlSetTotalSec(this.value)"> 秒
                    </label>
                    <span class="sb-dir-zoom">缩放
                        <button class="sb-tl-mini" onclick="StoryboardModule.tlZoom(-1)">－</button>
                        <button class="sb-tl-mini" onclick="StoryboardModule.tlZoom(1)">＋</button>
                    </span>
                    <span class="sb-dir-sep"></span>
                    <span class="sb-dir-guide">Guide Strength
                        <input type="number" id="tlGuide" min="0" max="2" step="0.05" value="${tl.guideStrength || '1.00'}"
                            oninput="StoryboardModule.tlSetGuide(this.value)">
                    </span>
                    <span class="sb-dir-guide" title="过渡柔和度：越小越硬切、越大越柔和。范围 0.001 ~ 1.0（0.001=硬切, 0.5=平滑, 0.8≈淡入淡出）">
                        Epsilon
                        <input type="number" id="tlEpsilon" min="0.001" max="1" step="0.001" value="${(tl.epsilon ?? 0.001)}"
                            oninput="StoryboardModule.tlSetEpsilon(this.value)">
                        <span class="sb-dir-eps-hint">0.001~1.0｜越大越柔</span>
                    </span>
                </div>
                <div class="sb-dir-scroll">
                    <div class="sb-dir-tracks" id="sbDirTracks"></div>
                </div>
                <div class="sb-dir-transport">
                    <button class="sb-dir-play" id="tlPlayBtn" onclick="StoryboardModule.tlTogglePlay()">▶</button>
                    <button class="sb-tl-mini" title="回到开头" onclick="StoryboardModule.tlSeekFrame(0)">⟲</button>
                    <input type="range" id="tlSeek" min="0" max="${tl.totalFrames}" value="${tl.playFrame || 0}"
                        oninput="StoryboardModule.tlSeekFrame(this.value)">
                    <span class="sb-dir-cur" id="tlCur">0.00s</span>
                </div>
                <div class="sb-dir-preview" id="tlPreview"></div>
                <audio id="tlAudioEl" preload="auto" style="display:none"></audio>
                <div id="tlVideoResult"></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="StoryboardModule.closeTimeline()">关闭</button>
                <button class="btn-primary" id="tlGenBtn" onclick="StoryboardModule.genVideo()">🎬 生成视频</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
        this._renderTracks();
        this._updatePreview();
    },

    // 重绘轨道区（标尺 + 图像轨 + 音频轨），不重建整个弹窗（拖拽时频繁调用）
    _renderTracks() {
        const tl = this._tl;
        const host = document.getElementById('sbDirTracks');
        if (!host) return;
        const ppf = tl.pxPerFrame;
        const total = tl.totalFrames;
        // 轨道总宽：取 max(总时长, 最远的块) + 余量，让超出部分能显示为置灰区
        const farImg = tl.imageClips.reduce((a, c) => Math.max(a, c.start + c.length), 0);
        const farAud = tl.audioClips.reduce((a, c) => Math.max(a, c.start + c.length), 0);
        const spanFrames = Math.max(total, farImg, farAud) + Math.round(2 * tl.fps);
        const trackW = Math.round(spanFrames * ppf);
        const totalPx = Math.round(total * ppf);

        // 标尺刻度（每 2 秒一个主刻度）
        let ruler = '';
        const stepSec = 2;
        for (let s = 0; s <= spanFrames / tl.fps; s += stepSec) {
            const x = Math.round(s * tl.fps * ppf);
            ruler += `<div class="sb-dir-tick" style="left:${x}px"><span>${s.toFixed(0)}s</span></div>`;
        }

        const imgBlocks = tl.imageClips.map((c, i) => this._clipHtml('img', c, i)).join('');
        const audBlocks = tl.audioClips.map((c, i) => this._clipHtml('aud', c, i)).join('');
        const playX = Math.round((tl.playFrame || 0) * ppf);

        host.style.width = trackW + 'px';
        host.innerHTML = `
            <div class="sb-dir-ruler" style="width:${trackW}px">${ruler}
                <div class="sb-dir-total-flag" style="left:${totalPx}px" title="视频总长">⟂</div>
            </div>
            <div class="sb-dir-row" data-track="img" style="width:${trackW}px">
                <div class="sb-dir-overflow" style="left:${totalPx}px;width:${Math.max(0, trackW - totalPx)}px"></div>
                ${imgBlocks}
            </div>
            <div class="sb-dir-row" data-track="aud" style="width:${trackW}px">
                <div class="sb-dir-overflow" style="left:${totalPx}px;width:${Math.max(0, trackW - totalPx)}px"></div>
                ${audBlocks}
            </div>
            <div class="sb-dir-playhead" id="tlPlayhead" style="left:${playX}px"></div>`;

        // 绑定拖拽（移位 + 左右裁剪手柄）
        host.querySelectorAll('.sb-dir-clip').forEach(el => this._bindClipDrag(el));
        // 标尺点击 = 定位播放头
        const ruler2 = host.querySelector('.sb-dir-ruler');
        if (ruler2) ruler2.onclick = (e) => {
            const rect = ruler2.getBoundingClientRect();
            this.tlSeekFrame(Math.round((e.clientX - rect.left) / ppf));
        };
        // 落位动画：换位松手后，让所有片段对 left 做一次平滑过渡
        if (tl._animateNext) {
            tl._animateNext = false;
            const clips = host.querySelectorAll('.sb-dir-clip');
            clips.forEach(el => el.classList.add('sb-dir-animate'));
            setTimeout(() => clips.forEach(el => el.classList.remove('sb-dir-animate')), 320);
        }
    },

    _clipHtml(kind, c, i) {
        const tl = this._tl;
        const ppf = tl.pxPerFrame;
        const left = Math.round(c.start * ppf);
        const width = Math.max(24, Math.round(c.length * ppf));
        const overflow = (c.start + c.length) > tl.totalFrames;   // 超出总长 → 半灰
        const secsLabel = (c.length / tl.fps).toFixed(1) + 's';
        // 块下方独立时长标签：clip 再窄也不会被挡（绝对定位在块正下方，居中显示）
        const secBelow = `<div class="sb-dir-clip-sec" style="left:${left}px;width:${width}px">${secsLabel}</div>`;
        if (kind === 'img') {
            const m = c.imageId != null ? Storage.getMediaById(this.projectId, c.imageId) : null;
            const url = m ? Storage.mediaUrl(m.data) : '';
            const selected = (c.uid === tl.selectedUid);
            const promptText = c.prompt ? this.esc(c.prompt) : '';   // 块底叠加显示的 local 提示词
            return `<div class="sb-dir-clip sb-dir-img ${overflow ? 'sb-dir-of' : ''} ${selected ? 'sb-dir-sel' : ''}" data-kind="img" data-uid="${c.uid}" data-i="${i}"
                style="left:${left}px;width:${width}px;${url ? `background-image:url('${url}')` : ''}">
                ${overflow ? '<div class="sb-dir-of-badge" title="超出视频总长，不会被合成">超出</div>' : ''}
                <div class="sb-dir-handle l" data-h="l" title="拖动改时长（后续图片跟随移动）"></div>
                <div class="sb-dir-clip-body" title="点击：在下方编辑提示词 / 拖动换位 / 拉两侧改时长">
                    ${url ? '' : '<span class="sb-dir-noimg">无图</span>'}
                    <span class="sb-dir-clip-meta">#${i + 1} · ${secsLabel}</span>
                    ${promptText ? `<span class="sb-dir-clip-prompt" title="${promptText}">${promptText}</span>` : ''}
                    <button class="sb-dir-clip-x" title="删除" onmousedown="event.stopPropagation()" onclick="StoryboardModule.tlDelClip('img','${c.uid}')">×</button>
                </div>
                <div class="sb-dir-handle r" data-h="r" title="拖动改时长（后续图片跟随移动）"></div>
            </div>${secBelow}`;
        } else {
            const trimSec = (c.trimStart / tl.fps).toFixed(1);
            // 序号：与该音频对齐的图像段保持一致（拿不到则按音频自身索引兜底）
            const imgIdx = c.imgUid ? tl.imageClips.findIndex(x => x.uid === c.imgUid) : -1;
            const no = (imgIdx >= 0 ? imgIdx : i) + 1;
            const talk = c.text ? this.esc(c.text) : '';
            return `<div class="sb-dir-clip sb-dir-aud ${overflow ? 'sb-dir-of' : ''}" data-kind="aud" data-uid="${c.uid}" data-i="${i}"
                style="left:${left}px;width:${width}px">
                ${overflow ? '<div class="sb-dir-of-badge" title="超出视频总长，不会被合成">超出</div>' : ''}
                <div class="sb-dir-handle l" data-h="trim" title="左侧=裁剪音频起点"></div>
                <div class="sb-dir-clip-body sb-dir-wave" title="${talk || '配音'}${c.trimStart ? `（裁 ${trimSec}s）` : ''}">
                    <span class="sb-dir-clip-meta">🎵 #${no} · ${secsLabel}${c.trimStart ? ` · 裁${trimSec}s` : ''}</span>
                    ${talk ? `<span class="sb-dir-clip-talk" title="${talk}">${talk}</span>` : ''}
                    <button class="sb-dir-clip-x" title="删除" onmousedown="event.stopPropagation()" onclick="StoryboardModule.tlDelClip('aud','${c.uid}')">×</button>
                </div>
                <div class="sb-dir-handle r" data-h="r" title="右侧=改时长"></div>
            </div>${secBelow}`;
        }
    },

    // 拖拽：
    //  图像轨——body 拖动=换位（越过相邻段中点即交换顺序，后续 ripple 跟随）；
    //         左右手柄=改时长（改完 relayout，后面所有图片自动顺移）。
    //  音频轨——body 拖动=自由移位；越过其他音频段中点时交换前后顺序；
    //         左手柄=裁剪起点，右手柄=改时长。
    _bindClipDrag(el) {
        const self = this;
        const ppf = this._tl.pxPerFrame;
        const kind = el.dataset.kind;
        const uid = el.dataset.uid;
        const onDown = (e) => {
            if (e.target.classList.contains('sb-dir-clip-x') || e.target.classList.contains('sb-dir-clip-edit')) return;
            const handle = e.target.dataset.h;   // 'l' | 'r' | 'trim' | undefined(body)
            const arr = kind === 'img' ? self._tl.imageClips : self._tl.audioClips;
            const clip = arr.find(c => c.uid === uid);
            if (!clip) return;
            e.preventDefault();
            const startX = e.clientX;
            const orig = { start: clip.start, length: clip.length, trimStart: clip.trimStart || 0 };
            const maxFrames = clip.audioDurationFrames || 0;   // 音频可用总帧（裁剪上限）
            let moved = false;
            // 图像本体拖动 = 换位（浮起预览，松手才落位）；音频本体拖动 = 始终吸附避让，互不重叠
            const isBodyDrag = !handle;
            const isImgReorder = isBodyDrag && kind === 'img';   // 仅图像走换位模型
            let dropTarget = null;               // 图像换位时计算出的目标插入索引

            if (isImgReorder) { el.classList.add('sb-dir-dragging'); document.body.classList.add('sb-dir-dragging-cursor'); }

            const onMove = (ev) => {
                const dFrames = Math.round((ev.clientX - startX) / ppf);
                if (Math.abs(ev.clientX - startX) > 3) moved = true;

                if (isImgReorder) {
                    // ===== 图像浮起换位：被拖块跟随鼠标平移，但 *不* 立即重排数组 =====
                    el.style.transform = `translateX(${ev.clientX - startX}px) translateY(-6px) scale(1.02)`;
                    el.style.zIndex = 50;
                    const pointerFrame = orig.start + dFrames + clip.length / 2;
                    dropTarget = self._calcDropIndex(arr, uid, pointerFrame, kind);
                    self._showDropIndicator(arr, uid, dropTarget, kind);
                    return;   // 不重绘整轨，避免被拖块被重建丢失浮起态
                }

                if (isBodyDrag && kind === 'aud') {
                    // ===== 音频移位：拖动时平滑自由跟随鼠标（允许临时重叠，不吸附，避免跳变）=====
                    // 松手时（onUp）再做一次防重叠吸附落位，落位带平滑动画。
                    clip.start = Math.max(0, orig.start + dFrames);
                    self._renderTracks();
                    // 给正在拖动的块加高亮，提示「松手后会自动避让对齐」
                    const cur = document.querySelector(`.sb-dir-clip[data-kind="aud"][data-uid="${uid}"]`);
                    if (cur) cur.classList.add('sb-dir-aud-dragging');
                    return;
                }

                if (handle === 'r') {
                    let nl = Math.max(5, orig.length + dFrames);
                    if (kind === 'aud' && maxFrames) nl = Math.min(nl, maxFrames - (clip.trimStart || 0));
                    if (kind === 'aud') {
                        // 不允许右拉跨过右侧最近音频段的起点（防重叠）
                        const rightStart = self._tl.audioClips
                            .filter(c => c.uid !== uid && c.start >= clip.start)
                            .reduce((min, c) => Math.min(min, c.start), Infinity);
                        if (rightStart !== Infinity) nl = Math.min(nl, rightStart - clip.start);
                        nl = Math.max(5, nl);
                    }
                    clip.length = nl;
                    if (kind === 'img') self._relayoutImages();   // 时长变化 → 后续图片顺移
                } else if (handle === 'l') {
                    // 图像左手柄：从左边拉伸/收缩长度（start 由顺序决定，故只改 length 后 relayout）
                    let nl = Math.max(5, orig.length - dFrames);
                    clip.length = nl;
                    self._relayoutImages();
                } else if (handle === 'trim') {
                    let nTrim = Math.max(0, orig.trimStart + dFrames);
                    if (maxFrames) nTrim = Math.min(nTrim, maxFrames - 5);
                    // 防重叠：向左裁（start 左移）不得越过左侧最近音频段的结束位置
                    const leftEnd = self._tl.audioClips
                        .filter(c => c.uid !== uid && (c.start + c.length) <= orig.start)
                        .reduce((mx, c) => Math.max(mx, c.start + c.length), 0);
                    const minTrim = orig.trimStart - (orig.start - leftEnd);   // 使 start ≥ leftEnd
                    if (nTrim < minTrim) nTrim = minTrim;
                    nTrim = Math.max(0, nTrim);
                    const applied = nTrim - orig.trimStart;
                    clip.trimStart = nTrim;
                    clip.start = Math.max(0, orig.start + applied);
                    clip.length = Math.max(5, orig.length - applied);
                }
                self._renderTracks();
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.classList.remove('sb-dir-dragging-cursor');
                self._clearDropIndicator();
                if (isImgReorder && moved && dropTarget != null) {
                    // 图像：松手才真正落位 → 移到目标索引 → relayout → 重绘（带平滑过渡）
                    const from = arr.findIndex(c => c.uid === uid);
                    const moving = arr[from];
                    arr.splice(from, 1);
                    arr.splice(dropTarget, 0, moving);
                    self._relayoutImages();
                    self._tl._animateNext = true;
                } else if (isBodyDrag && kind === 'aud' && moved) {
                    // 音频：拖动时自由跟随（可能临时重叠），松手时一次性吸附避让到不重叠位置，
                    // 再按 start 排序保持视觉顺序，启用平滑落位动画（不会瞬移跳变）。
                    clip.start = self._snapAudioAvoid(clip, clip.start);
                    self._reorderAudioByStart(uid);
                    self._tl._animateNext = true;
                }
                // 未发生拖动 = 视为「点击」：图像段则选中并在预览区展示
                if (isBodyDrag && !moved && kind === 'img') self._tl.selectedUid = uid;
                self._renderTracks();
                self._updatePreview();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
        el.addEventListener('mousedown', onDown);
    },

    // 根据指针所在帧，计算「松手后」应插入到的数组索引（不修改数组，仅返回索引）
    _calcDropIndex(arr, uid, pointerFrame, kind) {
        if (kind === 'aud') {
            // 音频：按 start 比较，落在某段中点之后则排在其后
            const others = arr.filter(c => c.uid !== uid);
            let target = 0;
            others.forEach(o => { if (pointerFrame > (o.start + o.length / 2)) target++; });
            return target;
        }
        // 图像：按当前连续排布的中心点比较
        let acc = 0, target = 0;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i].uid === uid) continue;
            const mid = acc + arr[i].length / 2;
            if (pointerFrame > mid) target++;
            acc += arr[i].length;
        }
        return target;
    },

    // 显示插入指示线：在「目标索引」处的左边界画一条竖线（图像按连续排布，音频按各段 start）
    _showDropIndicator(arr, uid, target, kind) {
        const host = document.getElementById('sbDirTracks');
        if (!host) return;
        const ppf = this._tl.pxPerFrame;
        let line = host.querySelector('.sb-dir-drop-line');
        if (!line) {
            line = document.createElement('div');
            line.className = 'sb-dir-drop-line';
            host.appendChild(line);
        }
        // 计算目标索引对应的 x（插入点左边界）
        let x = 0;
        if (kind === 'img') {
            const others = arr.filter(c => c.uid !== uid);
            let acc = 0;
            for (let i = 0; i < target; i++) acc += (others[i] ? others[i].length : 0);
            x = Math.round(acc * ppf);
        } else {
            const others = arr.filter(c => c.uid !== uid).sort((a, b) => a.start - b.start);
            x = others[target] ? Math.round(others[target].start * ppf)
                               : (others.length ? Math.round((others[others.length - 1].start + others[others.length - 1].length) * ppf) : 0);
        }
        const row = host.querySelector(kind === 'img' ? '.sb-dir-row[data-track="img"]' : '.sb-dir-row[data-track="aud"]');
        const top = row ? row.offsetTop : 0;
        const h = row ? row.offsetHeight : 56;
        line.style.cssText = `left:${x}px;top:${top}px;height:${h}px`;
    },
    _clearDropIndicator() {
        const host = document.getElementById('sbDirTracks');
        const line = host && host.querySelector('.sb-dir-drop-line');
        if (line) line.remove();
    },

    // 音频：按各段当前 start 排序数组顺序（保持视觉顺序与数组一致，便于换位语义）
    _reorderAudioByStart(uid) {
        this._tl.audioClips.sort((a, b) => a.start - b.start);
    },

    // 快速拖动时的磁吸避让：把目标 start 夹到不与其它音频段重叠的位置。
    // 按拖动方向把自己贴到碰撞段的外侧边界（碰到别的段就停下，不穿过）。慢速拖动不调用此方法（允许重叠）。
    _snapAudioAvoid(clip, ns) {
        const len = clip.length;
        const others = this._tl.audioClips.filter(c => c.uid !== clip.uid);
        if (!others.length) return Math.max(0, ns);
        const movingRight = ns > clip.start;     // 拖动方向
        let s = Math.max(0, ns);
        for (let iter = 0; iter < others.length + 1; iter++) {
            let collided = false;
            for (const o of others) {
                const oS = o.start, oE = o.start + o.length;
                if (s < oE && s + len > oS) {         // 区间相交
                    if (movingRight) s = oE;          // 向右拖 → 贴到该段右侧
                    else s = Math.max(0, oS - len);   // 向左拖 → 贴到该段左侧
                    collided = true;
                }
            }
            if (!collided) break;
        }
        // 兜底：仍重叠（空间不足）→ 退回原位，避免强行叠上去
        const stillBad = others.some(o => s < o.start + o.length && s + len > o.start);
        return stillBad ? clip.start : Math.max(0, s);
    },

    // ---- 工具栏 / 总时长 / 缩放 ----
    tlSetTotalSec(v) {
        const f = Math.max(this._tl.fps, Math.round(parseFloat(v) * this._tl.fps) || 0);
        this._tl.totalFrames = f;
        const seek = document.getElementById('tlSeek');
        if (seek) seek.max = f;
        if ((this._tl.playFrame || 0) > f) this.tlSeekFrame(f);
        this._renderTracks();
    },
    tlZoom(dir) {
        const steps = [0.4, 0.7, 1.0, 1.4, 2.0, 2.8, 4.0];
        let idx = steps.findIndex(s => Math.abs(s - this._tl.pxPerFrame) < 0.01);
        if (idx < 0) idx = 3;
        idx = Math.max(0, Math.min(steps.length - 1, idx + dir));
        this._tl.pxPerFrame = steps[idx];
        this._renderTracks();
    },
    tlSetGuide(v) { this._tl.guideStrength = String(parseFloat(v) || 1).toFixed(2); },
    tlSetEpsilon(v) {
        let n = parseFloat(v);
        if (isNaN(n)) n = 0.001;
        n = Math.max(0.001, Math.min(1, n));   // 合法区间 0.001 ~ 1.0
        this._tl.epsilon = n;
    },

    // ---- 删除 / 添加 块 ----
    tlDelClip(kind, uid) {
        const arr = kind === 'img' ? this._tl.imageClips : this._tl.audioClips;
        const idx = arr.findIndex(c => c.uid === uid);
        if (idx >= 0) arr.splice(idx, 1);
        if (kind === 'img') this._relayoutImages();   // 删图后重新紧贴
        this._renderTracks();
        this._updatePreview();
    },

    // 编辑某图像段的 local 提示词（弹出内嵌编辑面板）
    tlEditPrompt(uid) {
        const c = this._tl.imageClips.find(x => x.uid === uid);
        if (!c) return;
        const i = this._tl.imageClips.indexOf(c);
        const wrap = document.createElement('div');
        wrap.className = 'sb-dir-prompt-pop';
        wrap.innerHTML = `
            <div class="sb-dir-prompt-card">
                <div class="sb-dir-prompt-head">✎ 编辑 local 提示词 · 第 ${i + 1} 段</div>
                <textarea class="form-textarea" id="tlPromptArea" rows="5" placeholder="输入该段画面的 local 提示词…">${this.esc(c.prompt || '')}</textarea>
                <div class="sb-dir-prompt-ops">
                    <button class="btn-secondary btn-tiny" id="tlPromptCancel">取消</button>
                    <button class="btn-primary btn-tiny" id="tlPromptSave">保存</button>
                </div>
            </div>`;
        document.body.appendChild(wrap);
        const area = wrap.querySelector('#tlPromptArea');
        area.focus();
        const close = () => { wrap.remove(); };
        wrap.querySelector('#tlPromptCancel').onclick = close;
        wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
        wrap.querySelector('#tlPromptSave').onclick = () => {
            c.prompt = area.value;
            close();
            this._renderTracks();
            this._updatePreview();
            App.showToast('提示词已更新', 'success');
        };
    },
    tlAddImage() {
        this._openMediaPicker('image', (mid) => {
            const tl = this._tl;
            tl.imageClips.push({ uid: Storage._uid(), imageId: mid, prompt: '', dialogue: {}, transition: 'cut', start: 0, length: 90 });
            this._relayoutImages();   // 紧贴排到末尾
            this._renderTimeline();
        });
    },
    tlAddAudio() {
        this._openMediaPicker('audio', (mid) => {
            const tl = this._tl;
            const a = { uid: Storage._uid(), audioId: mid, start: tl.playFrame || 0, length: 90, trimStart: 0, audioDurationFrames: 0 };
            tl.audioClips.push(a);
            this._renderTimeline();
            this._loadAudioDurations();
        });
    },

    // ---- 播放预览：播放头随帧推进，图像按 start/length 切换，音频按块同步 ----
    tlSeekFrame(f) {
        const tl = this._tl;
        tl.playFrame = Math.max(0, Math.min(Math.round(parseFloat(f)) || 0, tl.totalFrames));
        const ph = document.getElementById('tlPlayhead');
        if (ph) ph.style.left = Math.round(tl.playFrame * tl.pxPerFrame) + 'px';
        const seek = document.getElementById('tlSeek');
        if (seek && +seek.value !== tl.playFrame) seek.value = tl.playFrame;
        const cur = document.getElementById('tlCur');
        if (cur) cur.textContent = (tl.playFrame / tl.fps).toFixed(2) + 's';
        // 播放中：仅换画面（不重建提示词输入框）；手动定位/暂停：完整刷新
        if (tl.playing) this._updateStage(); else this._updatePreview();
        this._syncAudioToFrame();
    },
    tlTogglePlay() {
        const tl = this._tl;
        tl.playing = !tl.playing;
        const btn = document.getElementById('tlPlayBtn');
        if (btn) btn.textContent = tl.playing ? '⏸' : '▶';
        if (tl.playing) {
            if (tl.playFrame >= tl.totalFrames) this.tlSeekFrame(0);
            tl._lastTs = performance.now();
            tl._pf = tl.playFrame;                 // 浮点帧累加器（避免每帧 round 丢失小数导致几乎不前进）
            const tick = (ts) => {
                if (!this._tl || !this._tl.playing) return;
                const dt = Math.min(0.1, (ts - tl._lastTs) / 1000);   // 限制单帧步进，切后台回来不跳变
                tl._lastTs = ts;
                tl._pf += dt * tl.fps;
                if (tl._pf >= tl.totalFrames) { this.tlSeekFrame(tl.totalFrames); this.tlTogglePlay(); return; }
                this.tlSeekFrame(tl._pf);          // tlSeekFrame 内部会取整显示，但累加用 _pf 保持精度
                tl._raf = requestAnimationFrame(tick);
            };
            tl._raf = requestAnimationFrame(tick);
        } else {
            if (tl._raf) cancelAnimationFrame(tl._raf);
            this._pauseAudio();
        }
    },
    // 当前帧应显示哪张图（命中 start..start+length 的最后一个）
    _imageAtFrame(f) {
        const tl = this._tl;
        let hit = null;
        tl.imageClips.forEach(c => { if (f >= c.start && f < c.start + c.length) hit = c; });
        return hit;
    },
    // 预览要显示哪段：播放中→跟随播放头当前帧；非播放→用户点选的 selectedUid（默认第一段）
    _previewClip() {
        const tl = this._tl;
        if (tl.playing) return this._imageAtFrame(tl.playFrame || 0);
        return tl.imageClips.find(c => c.uid === tl.selectedUid) || tl.imageClips[0] || null;
    },
    // 点击某图像段 → 选中并在预览区展示该图、编辑其提示词
    tlSelectClip(uid) {
        if (!this._tl) return;
        this._tl.selectedUid = uid;
        this._renderTracks();        // 刷新选中描边
        this._updatePreview();
    },
    // 时间轴下方：只显示「当前段」的可编辑 local 提示词（不再显示画面 stage）。点选 / 播放命中变化 / 停止 / 编辑后调用。
    _updatePreview() {
        const tl = this._tl;
        const host = document.getElementById('tlPreview');
        if (!host) return;
        const c = this._previewClip();
        const idx = c ? tl.imageClips.indexOf(c) + 1 : 0;
        const promptVal = c ? (c.prompt || '') : '';
        // 当前台词：播放时取命中当前帧的音频块台词；非播放时取选中图像段对应音频/对白
        const talk = this._currentTalk();
        const talkBar = talk
            ? `<div class="sb-dir-prev-talk"><span class="sb-dir-prev-talk-icon">🗣️</span><span class="sb-dir-prev-talk-text">${this.esc(talk)}</span></div>`
            : '';
        host.innerHTML = c ? `
            ${talkBar}
            <div class="sb-dir-prev-prompt">
                <div class="sb-dir-prev-phead">
                    <span class="sb-dir-prev-plabel">✎ 第 ${idx} 段 · local 提示词</span>
                    <span class="sb-dir-prev-phint">${tl.playing ? '播放中（跟随播放头）' : '点击上方图像段切换 · 编辑后自动保存'}</span>
                </div>
                <textarea class="form-textarea sb-dir-prev-parea" id="tlPrevPrompt"
                    placeholder="描述这一段的画面内容…（local 提示词）"
                    oninput="StoryboardModule.tlSetPrompt('${c.uid}', this.value)">${this.esc(promptVal)}</textarea>
            </div>`
            : `<div class="sb-dir-prev-empty">点击上方图像段，可在此查看 / 编辑该段的 local 提示词</div>`;
        this._prevUid = c ? c.uid : null;
        this._prevTalk = talk;
    },
    // 当前应显示的台词：播放中→命中当前帧的音频块台词；非播放→选中图像段对应的台词
    _currentTalk() {
        const tl = this._tl;
        if (!tl) return '';
        if (tl.playing) {
            const f = tl.playFrame || 0;
            let hit = null;
            tl.audioClips.forEach(c => { if (f >= c.start && f < c.start + c.length) hit = c; });
            if (hit) return hit.text || '';
            // 没有命中音频时，退而显示当前画面段的对白文本
            const img = this._imageAtFrame(f);
            return (img && img.dialogue && img.dialogue.text) || '';
        }
        const sel = tl.imageClips.find(c => c.uid === tl.selectedUid) || tl.imageClips[0];
        if (!sel) return '';
        const aud = tl.audioClips.find(a => a.imgUid === sel.uid);
        if (aud && aud.text) return aud.text;
        return (sel.dialogue && sel.dialogue.text) || '';
    },
    // 播放时高频调用：命中段或台词变化才刷新提示词区（无画面 stage，避免打断编辑）
    _updateStage() {
        const c = this._previewClip();
        const curUid = c ? c.uid : null;
        const talk = this._currentTalk();
        if (curUid !== this._prevUid || talk !== this._prevTalk) this._updatePreview();
    },
    _stageInner(c) {
        const m = c && c.imageId != null ? Storage.getMediaById(this.projectId, c.imageId) : null;
        const url = m ? Storage.mediaUrl(m.data) : '';
        return url
            ? `<img src="${url}" class="sb-dir-prev-img">`
            : `<div class="sb-dir-prev-empty">（此处无画面 / 超出片段）</div>`;
    },
    // 预览区编辑提示词时实时写回（轻量，不重渲染轨道，避免打断输入）；同步更新块底叠加文字
    tlSetPrompt(uid, v) {
        const c = this._tl && this._tl.imageClips.find(x => x.uid === uid);
        if (!c) return;
        c.prompt = v;
        // 只更新对应块底部的提示词 span，不整轨重绘（避免打断 textarea 输入）
        const host = document.getElementById('sbDirTracks');
        const el = host && host.querySelector(`.sb-dir-clip[data-uid="${uid}"][data-kind="img"] .sb-dir-clip-body`);
        if (!el) return;
        let span = el.querySelector('.sb-dir-clip-prompt');
        if (v) {
            if (!span) {
                span = document.createElement('span');
                span.className = 'sb-dir-clip-prompt';
                el.insertBefore(span, el.querySelector('.sb-dir-clip-x'));
            }
            span.textContent = v;
            span.title = v;
        } else if (span) {
            span.remove();
        }
    },
    // 音频同步：找到命中当前帧的音频块，定位 audio 元素到 (trimStart + 帧偏移)
    _syncAudioToFrame() {
        const tl = this._tl;
        const el = document.getElementById('tlAudioEl');
        if (!el) return;
        const f = tl.playFrame || 0;
        let hit = null;
        tl.audioClips.forEach(c => { if (f >= c.start && f < c.start + c.length) hit = c; });
        if (!hit) { if (!el.paused) el.pause(); el._uid = null; return; }
        const m = hit.audioId != null ? Storage.getMediaById(this.projectId, hit.audioId) : null;
        if (!m) return;
        const url = Storage.mediaUrl(m.data);
        if (el._uid !== hit.uid) { el.src = url; el._uid = hit.uid; }
        const targetSec = ((hit.trimStart || 0) + (f - hit.start)) / tl.fps;
        if (Math.abs((el.currentTime || 0) - targetSec) > 0.18) { try { el.currentTime = targetSec; } catch (e) {} }
        if (tl.playing) { el.play().catch(() => {}); } else if (!el.paused) { el.pause(); }
    },
    _pauseAudio() { const el = document.getElementById('tlAudioEl'); if (el && !el.paused) el.pause(); },

    // ---- 媒体选择器（图像 / 音频）----
    _openMediaPicker(kind, onPick) {
        const p = Storage.getProject(this.projectId);
        const lib = (p.mediaLibrary || []).filter(m => m.type === kind);
        this._pickCb = onPick;
        const items = lib.map(m => {
            const url = Storage.mediaUrl(m.data);
            return kind === 'image'
                ? `<div class="sb-pick-item" onclick="StoryboardModule._doPick(${m.id})"><img src="${url}"><span>${this.esc(m.ownerType || '')}</span></div>`
                : `<div class="sb-pick-item sb-pick-audio" onclick="StoryboardModule._doPick(${m.id})"><audio controls src="${url}" preload="none"></audio><span>${this.esc(m.ownerType || m.fileName || '')}</span></div>`;
        }).join('');
        const layer = document.getElementById('modalContent');
        layer.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">选择${kind === 'image' ? '图像' : '音频'}</h2><button class="modal-close" onclick="StoryboardModule._cancelPick()">×</button></div>
            <div class="modal-body"><div class="sb-pick-grid">${items || '<div class="empty-state-text">媒体库为空</div>'}</div></div>
            <div class="modal-footer"><button class="btn-secondary" onclick="StoryboardModule._cancelPick()">返回时间轴</button></div>`;
    },
    _doPick(mid) { const cb = this._pickCb; this._pickCb = null; if (cb) cb(mid); },
    _cancelPick() { this._renderTimeline(); },

    closeTimeline() {
        if (this._tl && this._tl._raf) cancelAnimationFrame(this._tl._raf);
        this._pauseAudio();
        this._tl = null; App.closeModal(); this.render(this.projectId);
    },

    async genVideo() {
        const tl = this._tl;
        if (!tl || !tl.imageClips.length) { App.showToast('请至少保留一个图像段', 'error'); return; }
        if (tl.playing) this.tlTogglePlay();
        const btn = document.getElementById('tlGenBtn');
        const resEl = document.getElementById('tlVideoResult');
        btn.disabled = true; btn.textContent = '⏳ 生成中…';
        resEl.innerHTML = '<div class="sb-cc-running"><div class="sb-spinner"></div> 正在调用 LTX2.3 导演台生成视频，时间较长请耐心等待…</div>';

        // 仅纳入落在总时长范围内（start < totalFrames）的块；length 截断到不超过总长
        const total = tl.totalFrames;
        const clampLen = (c) => Math.max(1, Math.min(c.length, total - c.start));

        const imageSegments = [];
        for (const c of [...tl.imageClips].sort((a, b) => a.start - b.start)) {
            if (c.start >= total) continue;                 // 完全超出 → 不合成
            const img = c.imageId != null ? Storage.getMediaById(this.projectId, c.imageId) : null;
            if (!img) continue;
            const b64 = await this._urlToB64(Storage.mediaUrl(img.data));
            imageSegments.push({ image_b64: b64, prompt: c.prompt || (c.dialogue && c.dialogue.text) || '', start: c.start, length: clampLen(c) });
        }
        if (!imageSegments.length) { btn.disabled = false; btn.textContent = '🎬 生成视频'; resEl.innerHTML = '<div class="sb-err">❌ 没有落在总时长范围内的图像段</div>'; return; }

        const audioSegments = [];
        for (const c of [...tl.audioClips].sort((a, b) => a.start - b.start)) {
            if (c.start >= total) continue;
            const aud = c.audioId != null ? Storage.getMediaById(this.projectId, c.audioId) : null;
            if (!aud) continue;
            const b64 = await this._urlToB64(Storage.mediaUrl(aud.data));
            audioSegments.push({ audio_b64: b64, audio_mime: aud.mime || 'audio/wav', start: c.start, length: clampLen(c), trimStart: c.trimStart || 0 });
        }

        try {
            const submit = await API.post('/api/storyboard/video', {
                imageSegments,
                audioSegments,
                total_frames: total,
                global_prompt: tl.globalPrompt || '',
                epsilon: (this._tl.epsilon ?? 0.001),
                guide_strength: tl.guideStrength || '1.00',
                use_custom_audio: audioSegments.length > 0,
                fps: tl.fps,
            });
            if (!submit.success || !submit.task_id) throw new Error(submit.error || '提交失败');
            const result = await this._pollTask(submit.task_id, (st) => {
                resEl.innerHTML = `<div class="sb-cc-running"><div class="sb-spinner"></div> 状态：${st === 'running' ? '渲染中…' : '排队中…'}（总长 ${(total / tl.fps).toFixed(1)}s）</div>`;
            }, 1000);
            if (result && result.video_base64) {
                const dataUrl = 'data:video/mp4;base64,' + result.video_base64;
                resEl.innerHTML = `<video class="sb-result-video" controls autoplay src="${dataUrl}"></video>
                    <div class="sb-dir-cur" style="margin-top:.5rem">✅ 生成成功（${result.frames || 0} 帧）。右键视频可保存。</div>`;
                btn.disabled = false; btn.textContent = '🔄 重新生成';
            } else {
                throw new Error('未产出视频');
            }
        } catch (e) {
            resEl.innerHTML = `<div class="sb-err">❌ ${this.esc(e.message)}</div>`;
            btn.disabled = false; btn.textContent = '🔄 重试';
        }
    },

    // ============================================================
    // 通用：异步任务轮询（统一走 /api/sb_task）
    // ============================================================
    // onStatus(status) 可选回调；interval 轮询间隔(ms)
    _pollTask(taskId, onStatus, interval) {
        interval = interval || 1500;
        return new Promise((resolve, reject) => {
            const tick = async () => {
                try {
                    const r = await API.post('/api/sb_task', { task_id: taskId });
                    if (!r.success) { reject(new Error(r.error || '查询失败')); return; }
                    if (r.status === 'done') { resolve(r.result || {}); return; }
                    if (r.status === 'error') { reject(new Error(r.error || '任务失败')); return; }
                    if (r.status === 'missing') { reject(new Error('任务已过期或服务重启')); return; }
                    if (onStatus) onStatus(r.status);
                    setTimeout(tick, interval);
                } catch (e) {
                    setTimeout(tick, interval * 2); // 网络抖动，退避重试
                }
            };
            tick();
        });
    },

    // 刷新后恢复进行中的四宫格生成轮询。
    // 任务持久化在 localStorage（按项目隔离）：刷新/切 tab 回来后从后端取回结果，
    // 卡片继续显示 spinner，避免重复消耗 API 配额。
    _resumePolls() {
        const tasks = this._loadFgTasks();
        const now = Date.now();
        let dirty = false;
        for (const gid in tasks) {
            const t = tasks[gid];
            // 超过 15 分钟视为过期
            if (!t || !t.taskId || now - (t.start || 0) > 900000) { delete tasks[gid]; dirty = true; continue; }
            // 该 group 仍存在才恢复（可能已被删除）
            const p = Storage.getProject(this.projectId);
            const exists = (p.storyboardGroups || []).some(x => x.id === gid);
            if (!exists) { delete tasks[gid]; dirty = true; continue; }
            // 内存中尚未在轮询 → 重新发起（spinner 由 _polls 标记驱动）
            if (!this._polls['fg_' + gid]) {
                this._polls['fg_' + gid] = t.taskId;
                // 恢复计时（以持久化的 start 为基准）
                this._fgStart[gid] = t.start || Date.now();
                this._startFgTimer(gid);
                this._pollFourGrid(gid, t.taskId);
            }
        }
        if (dirty) {
            try { localStorage.setItem(this._fgTaskKey(), JSON.stringify(tasks)); } catch (e) {}
        }
    },

    esc(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }
};