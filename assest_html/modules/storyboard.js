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
    _fgTimers: {},       // gid → 计时器 interval（四宫格生成 s 数显示）
    _fgStart: {},        // gid → 开始时间戳
    _audioTasks: {},     // 'gid:panel' → 开始时间戳（面板配音进行中）
    _SB_TASK_KEY: 'assest_sb_gen_task',   // localStorage：进行中的 CC 分镜生成任务
    _SB_RESULT_KEY: 'assest_sb_gen_result', // localStorage：上次分镜生成结果横幅（常驻，手动关或下次覆盖）
    _FG_TASK_KEY: 'assest_sb_fg_tasks',   // localStorage：进行中的四宫格生成任务（刷新可恢复）
    _VIDEO_TASK_KEY: 'assest_sb_video_task',   // localStorage：进行中的导演台视频生成任务（关弹窗/刷新仍保持）
    _VIDEO_ERR_KEY: 'assest_sb_video_err',     // localStorage：上次视频生成失败信息（顶部显示，可×，下次生成清除）

    // 转场 → Epsilon 映射（依据 WhatDreamsCost LTXDirector 节点源码：
    // <0.1 都是硬边界，paper 默认 0.001；越大过渡越柔和）
    TRANSITION_EPSILON: { cut: 0.001, smooth: 0.5, fade: 0.8 },
    FPS: 24,   // 默认 24fps：同秒数下总帧数更少，二阶段(上采样精修)显存与耗时更低；可在时间轴弹窗切到 30fps

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
                if (g.single && g.inlineParent) return;   // 内嵌在四宫格组里的单分镜，由父组卡片负责渲染，不在顶层平铺
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
                    <button class="sb-compose-btn" onclick="StoryboardModule.openTimeline()" ${groups.length ? '' : 'disabled'} title="进入时间轴合成视频：将已勾选的分镜按图像/音频双轨对齐后生成成片"><span class="sb-compose-ic">🎞️</span><span>合成视频</span></button>
                    <button class="btn-secondary sb-jump-sel" onclick="StoryboardModule.jumpToFirstSelected()" ${groups.length ? '' : 'disabled'} title="滚动定位到第一个『已勾选合成视频』的分镜并高亮">🎯 定位首选</button>
<button class="btn-secondary" onclick="StoryboardModule.importGroupsFromFile()" title="上传分镜 JSON（含 person / 分镜 字段，与智能生成的格式一致），也可直接把 .json 拖到下方区域">📥 上传 JSON</button>
<input type="file" id="sbImportJson" accept="application/json,.json" style="display:none" onchange="StoryboardModule.onImportJsonFile(event)">
<button class="btn-secondary" onclick="StoryboardModule.openPasteJsonModal()" title="直接粘贴分镜 JSON 文本（含 person / 分镜 字段，与上传 JSON 同格式）解析导入，无需保存成文件">📋 粘贴 JSON</button>
                    <button class="btn-secondary" onclick="StoryboardModule.exportContextJson()" title="导出剧本 / 人物 / 道具 / 场景为 JSON，供另一台机器导入或生成分镜复用">📤 导出素材</button>
                    <button class="btn-secondary sb-mark-global" onclick="StoryboardModule.markAllSelectedGlobal()" ${groups.length ? '' : 'disabled'} title="把所有组中当前『已勾选合成』的分镜一键标记为已处理（置灰并取消勾选）">✅ 标记已选</button>
                    <button class="btn-secondary sb-unsel-all" onclick="StoryboardModule.unselectAllGlobal()" ${groups.length ? '' : 'disabled'} title="取消所有组中当前『已勾选合成』的分镜（不改变已标记状态）">☐ 全部取消</button>
                    <button class="btn-secondary sb-trans-toggle ${Storage.getSettings().disableTransition ? 'on' : ''}" onclick="StoryboardModule.toggleDisableTransition()" title="禁用转场：合成视频时不再在相邻两段之间插入转场段（不拼接转场文本/时长）；未禁用时保持现状。">${Storage.getSettings().disableTransition ? '🚫 转场已禁用' : '🔀 禁用转场'}</button>
                    <button class="btn-secondary btn-ghost-danger sb-del-all" onclick="StoryboardModule.delAllGroups()" ${groups.length ? '' : 'disabled'} title="一键删除当前项目下的全部分镜（四宫格 + 单分镜），此操作不可撤销">🗑️ 全部删除</button>
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

        // 四宫格图像提示词（nano）：过长时提供「🔍 查看完整」点击弹窗显示全文；正文保持单行省略 + 可就地编辑（失焦自动保存）
        const nano = g.nanoPrompt || '';
        const nanoLong = nano.length > 90;
        const nanoRow = `
            <div class="meta-section">
                <div class="meta-header">
                    <span class="meta-label">四宫格生成提示词</span>
                    ${nanoLong ? `<button class="btn-ghost btn-tiny" title="弹窗显示完整提示词内容" onclick="StoryboardModule.viewNanoFull('${g.id}')">🔍 查看完整</button>` : ''}
                </div>
                ${InlineEdit.field(nano, {
                    placeholder: '点击填写 NANO 提示词（@图1=…）',
                    className: 'meta-content sb-nano clamp-1',
                    data: { edit: 'sb-group', gid: g.id, field: 'nanoPrompt' } })}
            </div>`;

        // 四个 local 提示词行（无限列表形式），每行右侧配音按钮；
        // 每个面板行后若挂有「内嵌单分镜」（g 在 storyboardGroups 里其后、inlineParent===g.id && inlinePanel===i 的单分镜组），则紧随其后渲染一行可删除的单分镜。
        const inlineFor = (i) => this._inlineSinglesOf(g.id, i);
        const localRows = [0, 1, 2, 3].map(i =>
            this.renderLocalRow(g, i, idx) + inlineFor(i).map(sg => this.renderInlineSingleRow(g, sg)).join('')
        ).join('');

        return `<div class="list-row" id="sbRow_${g.id}">
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

    // 在四宫格组的「第 panelIdx 格之后」插入一个内嵌单分镜。
    // 内嵌单分镜本质是一个普通的顶层单分镜对象（复用全部单分镜功能：生成图/配音/参考图/历史/删除/合成），
    // 只是带 inlineParent + inlinePanel 标记，并被放在 storyboardGroups 里「父组之后」，由父组卡片负责把它渲染在对应面板行下面（不同底色、可删除）。
    insertSingleInGroup(gid, panelIdx) {
        panelIdx = parseInt(panelIdx, 10) || 0;
        const p = Storage.getProject(this.projectId);
        const groups = (p.storyboardGroups || []).slice();
        const at = groups.findIndex(x => String(x.id) === String(gid));
        if (at < 0) return;
        const single = {
            id: Storage._uid(),
            single: true,
            inlineParent: gid,          // 归属的四宫格组
            inlinePanel: panelIdx,      // 插在该组第 panelIdx 格之后
            prompt: '',
            transition: 'cut',
            imageId: null,
            imageError: '',
            refImageIds: [],
            audioId: null,
            audioError: '',
            refAudioId: null,
            dialogue: { character: '', text: '', tone: '' },
        };
        // 放到「父组同组其它内嵌单分镜之后」：找到父组后连续的内嵌单分镜末尾位置插入，保证顺序稳定。
        let insertPos = at + 1;
        while (insertPos < groups.length && groups[insertPos].single && groups[insertPos].inlineParent === gid) insertPos++;
        groups.splice(insertPos, 0, single);
        Storage.updateProject(this.projectId, { storyboardGroups: groups });
        App.showToast(`已在第 ${panelIdx + 1} 格后插入单分镜，可设置参考图/配音并生成`, 'success');
        this.render(this.projectId);
    },

    // 取某四宫格组「第 panelIdx 格之后」的内嵌单分镜列表（按 storyboardGroups 中的顺序）
    _inlineSinglesOf(gid, panelIdx) {
        const p = Storage.getProject(this.projectId);
        return (p.storyboardGroups || []).filter(x =>
            x.single && x.inlineParent === gid && (parseInt(x.inlinePanel, 10) || 0) === panelIdx);
    },

    // ===== 构建「画面序列」：把所有分镜组按时间轴顺序展开成一串『画面』。
    // 每个画面 = { kind:'panel'|'single', gid, panel, mediaId }。mediaId 为该画面代表图（可能为 null，未生成）。
    // 用于推算某个单分镜的「前一帧 / 后一帧」默认参考图。展开规则（与合成顺序一致，但编辑期全量、不看勾选）：
    //   - 四宫格组：4 个面板各为一个画面（panelImages[i]），每个面板后紧跟它在该格的内嵌单分镜（按库顺序，imageId）。
    //   - 顶层单分镜：一个画面（imageId）。
    _buildFrameSeq() {
        const p = Storage.getProject(this.projectId);
        const groups = p.storyboardGroups || [];
        const seq = [];
        groups.forEach(g => {
            if (!g) return;
            if (g.inlineParent) return;   // 内嵌单分镜由其父组面板循环负责插入，顶层跳过避免重复
            if (g.single) {
                seq.push({ kind: 'single', gid: g.id, panel: 0, mediaId: g.imageId != null ? g.imageId : null });
                return;
            }
            // 四宫格组：4 个面板，每格后挂它的内嵌单分镜
            for (let i = 0; i < 4; i++) {
                const imgId = (g.panelImages || [])[i];
                seq.push({ kind: 'panel', gid: g.id, panel: i, mediaId: imgId != null ? imgId : null });
                this._inlineSinglesOf(g.id, i).forEach(sg => {
                    seq.push({ kind: 'single', gid: sg.id, panel: 0, mediaId: sg.imageId != null ? sg.imageId : null });
                });
            }
        });
        return seq;
    },

    // 取某单分镜 g 在「画面序列」里的前一帧 / 后一帧代表图 mediaId（找不到/未生成则为 null）。
    // 返回 { prevId, nextId }。
    _neighborFrameIds(g) {
        if (!g) return { prevId: null, nextId: null };
        const seq = this._buildFrameSeq();
        const idx = seq.findIndex(s => s.kind === 'single' && String(s.gid) === String(g.id));
        if (idx < 0) return { prevId: null, nextId: null };
        const prev = idx > 0 ? seq[idx - 1] : null;
        const next = idx < seq.length - 1 ? seq[idx + 1] : null;
        return {
            prevId: prev && prev.mediaId != null ? prev.mediaId : null,
            nextId: next && next.mediaId != null ? next.mediaId : null,
        };
    },

    // 渲染「内嵌在四宫格里的单分镜」行：复用单分镜卡片，外层包一个 sb-inline-single 容器（不同底色 + 可删除）。
    renderInlineSingleRow(parentGroup, sg) {
        // 复用 renderSingleCard 生成完整单分镜卡片（含生成/上传/参考图/台词/配音/历史/删除等全部能力）
        const card = this.renderSingleCard(sg, 0);
        const panelIdx = parseInt(sg.inlinePanel, 10) || 0;
        const panelLabel = panelIdx + 1;
        return `<div class="sb-inline-single" title="内嵌单分镜：合成视频时插在第 ${panelLabel} 格之后">
            <div class="sb-inline-single-tag">↳ 内嵌单分镜（第 ${panelLabel} 格后）</div>
            ${card}
            <div class="sb-inline-single-add">
                <button class="btn-ghost btn-tiny" title="在本内嵌单分镜之后再插入一个内嵌单分镜（前一帧默认取上一个内嵌单分镜的成品图）" onclick="StoryboardModule.insertSingleInGroup('${parentGroup.id}',${panelIdx})">＋ 在此后再加单分镜</button>
            </div>
        </div>`;
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
        const d = g.dialogue || {};

        const imgHistCount = Storage.getMediaForItem(this.projectId, 'storyboards', g.id + '_single').filter(m => m.type === 'image').length;

        const placeholder = imgGenning
            ? `<div class="sb-spinner"></div><span id="siImgTimer_${g.id}">生成中…</span>`
            : (imgErr ? '<span style="font-size:1.6rem">⚠️</span><span>生成失败</span>' : '🖼️ 待生成单图');

        const selected = g.selected !== false;  // 默认选中
        const marked = !!g.marked;

        const imgArea = `<div class="list-row-img" onclick="${imgUrl ? `CharacterModule.openImageZoom('${imgUrl}','单分镜','')` : ''}">
                    ${imgUrl ? `<img src="${imgUrl}" alt="单分镜">` : `<div class="sb-thumb-placeholder ${imgErr ? 'sb-thumb-error' : ''}">${placeholder}</div>`}
                </div>`;
        return `<div class="list-row sb-single-row ${marked ? 'sb-marked' : (selected ? 'sb-picked' : '')}" id="sbRow_${g.id}">
            <div class="list-row-img-section">
                ${imgArea}
                <div class="list-img-btns sb-single-img-btns">
                    <button class="btn-ghost btn-tiny ${imgGenning ? 'btn-disabled' : ''}" id="siImgBtn_${g.id}" ${imgGenning ? 'disabled' : ''}
                        onclick="${imgGenning ? '' : `StoryboardModule.openSingleGenModal('${g.id}')`}">${imgGenning ? '⏳ 生成中' : '🎨 生成'}</button>
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule.uploadSingleImage('${g.id}')">📁 上传</button>
                    <button class="btn-ghost btn-tiny" title="从历史/素材库选一张图直接替换当前画面" onclick="StoryboardModule.replaceSingleImage('${g.id}')">🔄 替换</button>
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
                        <div class="meta-header">
                            <span class="meta-label">local 提示语</span>
                            <span class="sb-prompt-actions">
                                <button class="btn-ghost btn-tiny" id="optBtn_${g.id}" title="用大模型结合剧本优化这条提示语" onclick="StoryboardModule.optimizeLocalPrompt('${g.id}')">✨ 优化</button>
                                ${g.promptBackup != null ? `<button class="btn-ghost btn-tiny" title="恢复优化前的提示语" onclick="StoryboardModule.restoreLocalPrompt('${g.id}')">↩ 恢复</button>` : ''}
                            </span>
                        </div>
                        ${InlineEdit.field(g.prompt || '', {
                            placeholder: '点击填写这个分镜的 local 提示语（也是生成弹窗里的画面提示语）…',
                            className: 'meta-content clamp-1',
                            data: { edit: 'sb-single', gid: g.id, field: 'prompt' } })}
                    </div>
                    <div class="meta-section sb-single-dialogue">
                        <div class="meta-content">
                            <div class="sb-dlg-line1">
                                ${this._singleCharSelect(g, d.character || '')}
                                <div class="sb-local-audio-btns">
                                    <button class="btn-ghost btn-tiny ${audGenning ? 'btn-disabled' : ''}" id="siAudBtn_${g.id}"
                                        onclick="${audGenning ? '' : `StoryboardModule.openSingleAudioModal('${g.id}')`}">${audGenning ? '⏳ 配音中' : (audUrl ? '🔄 配音' : '🔊 配音')}</button>
                                    <button class="btn-ghost btn-tiny ${audUrl ? '' : 'btn-disabled'}" id="siAplay_${g.id}"
                                        onclick="${audUrl ? `StoryboardModule.toggleSinglePlay('${g.id}')` : ''}">▶ 播放</button>
                                </div>
                            </div>
                            <div class="sb-dlg-line2">
                                ${InlineEdit.field(d.text || '', {
                                    placeholder: '点击填写台词…',
                                    className: 'sb-dlg-text',
                                    data: { edit: 'sb-single-dlg', gid: g.id, field: 'text' } })}
                                <span class="sb-dlg-tone-wrap">
                                    <span class="sb-dlg-tone-icon">🎭</span>
                                    ${InlineEdit.field(d.tone || '', {
                                        single: true, placeholder: '语气',
                                        className: 'sb-dlg-tone clamp-1',
                                        data: { edit: 'sb-single-dlg', gid: g.id, field: 'tone' } })}
                                </span>
                            </div>
                            ${audUrl ? `<audio id="siAaudio_${g.id}" preload="none" src="${audUrl}" style="display:none"></audio>` : ''}
                            ${audUrl ? `<div class="sb-single-audio-row"><span class="sb-dim-hint">成品配音：</span>${App.audioDragHandle(audUrl, `分镜配音_${g.id}.${(aud.mime||'').includes('mpeg')?'mp3':(aud.mime||'').includes('flac')?'flac':'wav'}`, '拖出')}</div>` : ''}
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
        // 四宫格成品图 / 切分 panel 图 / 单分镜图（ownerType=storyboards）
        // ownerId 后缀历史上有多种：<gid>_quad、<gid>_mockgrid（四宫格成品）；<gid>_panelN、<gid>_pqN_panelM（切分）；
        // <gid>_single（单图）；以及「裸 gid」（早期四宫格成品图直接以组 id 作 ownerId）。
        // 为稳妥识别「四宫格成品图」，不再仅靠 ownerId 后缀，而是优先用各分镜组的 g.fourGridImageId 字段建立 mediaId→该组 的映射。
        const sbGroups = p.storyboardGroups || [];
        const gidIndex = (gid) => sbGroups.findIndex(x => String(x.id) === String(gid));
        // mediaId(四宫格成品图) → { gid }，由分镜组的 fourGridImageId 反查
        const quadIdToGid = {};
        sbGroups.forEach(g => {
            if (g && g.fourGridImageId != null) quadIdToGid[String(g.fourGridImageId)] = String(g.id);
        });
        // 把 ownerId 去掉已知后缀，得到所属分镜组 gid（兼容 _mockgrid/_quad/_panelN/_pqK_panelN/_pqK/_single）
        const gidOfOwner = (owner) => {
            let mm;
            if ((mm = owner.match(/^(.+?)_pq\d+_panel\d+$/))) return mm[1];
            if ((mm = owner.match(/^(.+?)_pq\d+$/))) return mm[1];
            if ((mm = owner.match(/^(.+?)_panel\d+$/))) return mm[1];
            if ((mm = owner.match(/^(.+?)_(quad|mockgrid|single)$/))) return mm[1];
            return owner;   // 裸 gid
        };
        const sbImgs = lib.filter(m => m.type === 'image' && m.ownerType === 'storyboards');
        sbImgs.forEach(m => {
            const owner = String(m.ownerId || '');
            let kind = 'other', panelIdx = -1;
            let mm;
            // 1) 切分图：_panelN 或 _pqK_panelN（面板扩展切分）
            if ((mm = owner.match(/_panel(\d+)$/))) { kind = 'panel'; panelIdx = parseInt(mm[1], 10); }
            // 2) 四宫格成品图：① 命中某分镜组 fourGridImageId（最可靠）；② 或 ownerId 以 _quad/_mockgrid 结尾
            else if (quadIdToGid[String(m.id)] != null || /_(quad|mockgrid)$/.test(owner)) { kind = 'quad'; }
            // 3) 单图
            else if (/_single$/.test(owner)) { kind = 'single'; }
            // gid：四宫格成品图优先用 fourGridImageId 反查到的组；否则按 ownerId 去后缀
            const gid = (kind === 'quad' && quadIdToGid[String(m.id)] != null) ? quadIdToGid[String(m.id)] : gidOfOwner(owner);
            const gi = gidIndex(gid);
            const sbNo = gi >= 0 ? gi + 1 : null;
            const kindLabel = kind === 'quad' ? '四宫格' : (kind === 'panel' ? `切分第${panelIdx + 1}格` : (kind === 'single' ? '单图' : '分镜图'));
            out.push({
                id: m.id, url: Storage.mediaUrl(m.data),
                group: '🎞️ 四宫格/切分', name: (sbNo ? `分镜${sbNo}·` : '') + kindLabel + ' #' + m.id,
                // 分镜分块用元信息
                sbGroupId: gid, sbNo, sbKind: kind, panelIdx,
            });
        });
        return out;
    },

    // 把图像资产按「分镜分块」组织：人物/道具/场景照旧按大类；分镜图按所属分镜分块，
    // 块内「四宫格成品图在前，切分/单图在后」。返回 [{ title, tag, items }]
    _groupAssetsBySb(all) {
        const blocks = [];
        // 1) 非分镜大类（人物/道具/场景）按原 group 各成一块
        const generalOrder = ['👤 人物', '🎁 道具', '🏞️ 场景'];
        generalOrder.forEach(label => {
            const items = all.filter(a => a.group === label);
            if (items.length) blocks.push({ title: label, tag: '', items });
        });
        // 2) 分镜图分块：
        //    - 「四宫格成品图(quad) / 切分图(panel)」按所属分镜组(sbGroupId) 分块，每行严格 5 张、整行发光；
        //      有 quad 时 quad 放该行第一列 + 它的 4 张切分；无 quad 则切分图每行 5 张（首列即切分图）。
        //    - 其它图（单图 single / 杂项 other / 无 gid 归属）统一收进「🎞️ 其它分镜图」块，平铺、不发光。
        const sbAll = all.filter(a => a.group === '🎞️ 四宫格/切分');
        const isGridKind = (a) => a.sbKind === 'quad' || a.sbKind === 'panel';
        const byGid = {};            // sbGroupId -> 该组的 quad/panel 图（按库顺序）
        const gidOrder = [];         // 维持分组首次出现的顺序
        const gidSbNo = {};          // sbGroupId -> sbNo（用于标题「分镜N」，孤儿组为 null）
        const otherSb = [];          // 非四宫格/切分图：单图、杂项、无 gid 归属
        sbAll.forEach(a => {
            if (a.sbGroupId != null && isGridKind(a)) {
                const g = String(a.sbGroupId);
                if (byGid[g] == null) { byGid[g] = []; gidOrder.push(g); gidSbNo[g] = a.sbNo; }
                byGid[g].push(a);
            } else {
                otherSb.push(a);
            }
        });
        // 2a) 每个分镜组：每行严格 5 张、整行发光。有 sbNo 的按 sbNo 升序在前，孤儿组(无 sbNo) 排其后。
        gidOrder
            .sort((x, y) => {
                const nx = gidSbNo[x], ny = gidSbNo[y];
                if (nx != null && ny != null) return nx - ny;
                if (nx != null) return -1;
                if (ny != null) return 1;
                return 0;
            })
            .forEach(g => {
                const list = byGid[g];                                 // 库顺序（含拖动结果）
                const quads = list.filter(a => a.sbKind === 'quad');   // 四宫格成品图
                const panels = list.filter(a => a.sbKind === 'panel'); // 切分图
                const rows = [];
                // ① 每个四宫格领头一行：首列 quad + 紧随的 4 张切分图
                quads.forEach((q, qi) => {
                    const group = panels.slice(qi * 4, qi * 4 + 4);
                    rows.push({ cells: [q, ...group], glow: true });
                });
                // ② 剩余切分图（多于 quads×4，或本组无 quad）：每行 5 张、整行发光
                const leftover = panels.slice(quads.length * 4);
                for (let st = 0; st < leftover.length; st += 5) {
                    rows.push({ cells: leftover.slice(st, st + 5), glow: true });
                }
                const no = gidSbNo[g];
                blocks.push({
                    title: no != null ? `🎬 分镜${no}` : '🎬 历史分镜组',
                    tag: quads.length ? '每行：四宫格 + 4 张切分' : '每行 5 张为一组',
                    items: list,
                    rows,
                });
            });
        // 2b) 其它图（非四宫格/切分）：平铺一块，不发光；保持 mediaLibrary 顺序（尊重拖动结果）
        if (otherSb.length) {
            blocks.push({ title: '🎞️ 其它分镜图', tag: '', items: otherSb });
        }
                return blocks;
    },

    // 统一渲染「历史图像选择」分块。mode: 'multi'(多选checkbox) | 'single'(单选点击)
    // singleClickCall: single 模式下点击某图调用的函数名前缀（接收 a.id）；chosen: Set<string>
    _renderPickBlocks(blocks, mode, chosen, singleClickCall) {
        // 每个 cell：支持「删除（×）」与「拖动排序」。拖放事件挂在 StoryboardModule 上。
        const dndAttrs = (a) =>
            `draggable="true" ondragstart="StoryboardModule._pickDragStart(event,${a.id})" ondragover="StoryboardModule._pickDragOver(event)" ondrop="StoryboardModule._pickDrop(event,${a.id})" ondragend="StoryboardModule._pickDragEnd(event)"`;
        const delBtn = (a) =>
            `<button type="button" class="sb-pick-del" title="删除这张图" onclick="event.stopPropagation();event.preventDefault();StoryboardModule._pickDeleteImage(${a.id})">×</button>`;
        const cellHtml = (a) => {
            const sel = chosen && chosen.has(String(a.id));
            if (mode === 'single') {
                return `
                    <div class="sb-pick-cell ${sel ? 'selected' : ''}" data-id="${a.id}" ${dndAttrs(a)} onclick="${singleClickCall}(${a.id})">
                        ${delBtn(a)}
                        <img src="${a.url}" loading="lazy">
                        <span class="sb-pick-name">${this.esc(a.name)}</span>
                    </div>`;
            }
            return `
                <label class="sb-pick-cell ${sel ? 'selected' : ''}" data-id="${a.id}" ${dndAttrs(a)}>
                    ${delBtn(a)}
                    <input type="checkbox" value="${a.id}" ${sel ? 'checked' : ''} onchange="this.closest('.sb-pick-cell').classList.toggle('selected', this.checked);StoryboardModule._updatePickCount()">
                    <img src="${a.url}" loading="lazy">
                    <span class="sb-pick-name">${this.esc(a.name)}</span>
                </label>`;
        };
        return blocks.map(blk => {
            // 有 rows（分镜块）按行渲染，每行最多 5 张；否则平铺 items
            // 行可能是新结构 {cells,glow} 或旧结构（纯数组，兜底兼容）。
            // glow:true（四宫格 + 它的 4 张切分）整行加 sb-pick-row-glow 发光框，作为一组关联图。
            const body = blk.rows
                ? blk.rows.map(row => {
                    const cells = Array.isArray(row) ? row : (row.cells || []);
                    const glow = !Array.isArray(row) && row.glow;
                    return `<div class="sb-pick-row${glow ? ' sb-pick-row-glow' : ''}">${cells.map(cellHtml).join('')}</div>`;
                }).join('')
                : `<div class="sb-pick-grid">${blk.items.map(cellHtml).join('')}</div>`;
            return `
            <div class="sb-pick-section sb-hist-block">
                <div class="sb-hist-block-title">${blk.title}（${blk.items.length}）${blk.tag ? `<span class="sb-hist-block-tag">${blk.tag}</span>` : ''}</div>
                ${body}
            </div>`;
        }).join('');
    },

    // ===== 历史图像选择弹窗：删除 / 拖动排序（参考图、合成选图、替换、引导图等所有 _renderPickBlocks 渲染的弹窗共用）=====
    // 删除：从媒体库删除该图，并把它从 DOM 移除（保留弹窗其它勾选状态，不整体重建）。
    async _pickDeleteImage(mediaId) {
        mediaId = parseInt(mediaId, 10);
        const m = Storage.getMediaById(this.projectId, mediaId);
        if (!m) return;
        const ok = await App.confirm({
            title: '删除图像',
            message: '确定删除这张图像吗？删除后它将从所有可选列表中消失，且无法恢复。',
            okText: '删除', cancelText: '取消',
        });
        if (!ok) return;
        Storage.deleteMediaItem(this.projectId, mediaId);
        // 从当前弹窗 DOM 移除对应 cell；若某分镜块/行因此空了，也一并移除空容器。
        const cell = document.querySelector('#modalContent .sb-pick-cell[data-id="' + mediaId + '"]');
        if (cell) {
            const row = cell.closest('.sb-pick-row');
            const grid = cell.closest('.sb-pick-grid');
            cell.remove();
            if (row && !row.querySelector('.sb-pick-cell')) row.remove();
            if (grid && !grid.querySelector('.sb-pick-cell')) grid.remove();
        }
        if (typeof this._updatePickCount === 'function') this._updatePickCount();
        App.showToast('已删除该图像', 'success');
        // 后台刷新分镜列表缩略图（被删图若正被某分镜使用，列表会同步更新）
        this.render(this.projectId);
    },

    // ===== 拖动排序：通过重排 mediaLibrary 中两张图的相对顺序实现（_allImageAssets 按库顺序读取）=====
    _pickDragStart(ev, mediaId) {
        this._pickDragId = parseInt(mediaId, 10);
        try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(mediaId)); } catch (e) {}
        const cell = ev.currentTarget;
        if (cell && cell.classList) cell.classList.add('sb-pick-dragging');
    },
    // 拖动经过某格时：按鼠标在该格的左半/右半，决定插入点是「该格之前」还是「之后」，
    // 并在对应一侧显示一条竖线光标（sb-pick-insert-before / sb-pick-insert-after），让用户看到将插入到哪两张图之间。
    _pickDragOver(ev) {
        ev.preventDefault();
        try { ev.dataTransfer.dropEffect = 'move'; } catch (e) {}
        const cell = ev.currentTarget;
        if (!cell || !cell.classList) return;
        // 自身不画光标
        if (parseInt(cell.getAttribute('data-id'), 10) === this._pickDragId) {
            this._clearInsertCursor();
            return;
        }
        const rect = cell.getBoundingClientRect();
        const before = (ev.clientX - rect.left) < rect.width / 2;   // 鼠标偏左 → 插到该格之前
        // 先清掉其它格的光标，只在当前目标格的一侧显示
        this._clearInsertCursor();
        cell.classList.add(before ? 'sb-pick-insert-before' : 'sb-pick-insert-after');
        this._pickInsert = { targetId: parseInt(cell.getAttribute('data-id'), 10), before };
    },
    _clearInsertCursor() {
        document.querySelectorAll('#modalContent .sb-pick-insert-before, #modalContent .sb-pick-insert-after')
            .forEach(el => el.classList.remove('sb-pick-insert-before', 'sb-pick-insert-after'));
    },
    _pickDragEnd(ev) {
        const cell = ev.currentTarget;
        if (cell && cell.classList) cell.classList.remove('sb-pick-dragging');
        this._clearInsertCursor();
        this._pickInsert = null;
    },
    // 放下：按光标位置（目标格之前/之后）把「拖起的图」插到对应处，重排 mediaLibrary 并同步移动 DOM。
    _pickDrop(ev, targetId) {
        ev.preventDefault();
        const dragId = this._pickDragId;
        targetId = parseInt(targetId, 10);
        // 优先用 dragover 记录的插入意图（含左/右半判定）；兜底用 targetId、默认插到之前。
        const insert = this._pickInsert || { targetId, before: true };
        const tId = insert.targetId != null ? insert.targetId : targetId;
        const before = insert.before !== false;
        this._clearInsertCursor();
        this._pickInsert = null;
        if (dragId == null || dragId === tId) { this._pickDragId = null; return; }
        const p = Storage.getProject(this.projectId);
        const lib = p.mediaLibrary || [];
        const di = lib.findIndex(m => m.id === dragId);
        const ti = lib.findIndex(m => m.id === tId);
        if (di < 0 || ti < 0) { this._pickDragId = null; return; }
        // 数据层：把 drag 项移动到 target 项「之前/之后」（保持其它顺序）
        const [moved] = lib.splice(di, 1);
        let newTi = lib.findIndex(m => m.id === tId);
        lib.splice(before ? newTi : newTi + 1, 0, moved);
        Storage.updateProject(this.projectId, { mediaLibrary: lib });
        // DOM 层：把 drag 的 cell 移动到 target 的 cell 之前/之后（同一容器内即时生效，无需重建弹窗）
        const dragCell = document.querySelector('#modalContent .sb-pick-cell[data-id="' + dragId + '"]');
        const targetCell = document.querySelector('#modalContent .sb-pick-cell[data-id="' + tId + '"]');
        if (dragCell && targetCell && dragCell !== targetCell) {
            if (before) targetCell.parentNode.insertBefore(dragCell, targetCell);
            else targetCell.parentNode.insertBefore(dragCell, targetCell.nextSibling);
        }
        this._pickDragId = null;
    },

    // ===== 选择参考图弹窗（多选，含全部前期图像）=====
    pickRefImages(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const all = this._allImageAssets();
        const chosen = new Set((g.refImageIds || []).map(String));
        if (!all.length) { App.showToast('暂无可选图像，请先在人物/道具/场景页生成图，或生成四宫格', 'info'); return; }

        // 按「分镜分块」展示：人物/道具/场景各成一块；分镜图按所属分镜分块（每行：四宫格 + 4 张切分）
        const blocks = this._groupAssetsBySb(all);
        const sections = this._renderPickBlocks(blocks, 'multi', chosen);

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🖼️ 选择参考图（可多选）</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body sb-pick-body">
                <p class="form-hint">从前期生成的所有图像中选择，作为本单分镜的参考图。分镜图每行：四宫格 + 它的 4 张切分图。</p>
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

    // ===== 四宫格某个面板：用历史「切分图」替换其画面（单选，点图即替换）=====
    // 历史只展示切分单格图(panel)/单图(single)，不显示完整四宫格大图(quad)；每行 4 张。
    // 交互：点某一张图 → 立即把它复制为本格画面（不调模型）。
    replacePanelImage(gid, i) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        i = parseInt(i, 10) || 0;
        const all = this._allImageAssets();
        if (!all.length) { App.showToast('暂无可选图像，请先在人物/道具/场景页生成图，或生成四宫格', 'info'); return; }
        const curId = (g.panelImages || [])[i];
        // 与「选参考图 / 合成选图」统一：按分镜分块，每行（四宫格 + 4 张切分）用发光框框起来；single 模式点图即替换。
        const blocks = this._groupAssetsBySb(all);
        const chosen = curId != null ? new Set([String(curId)]) : null;
        // 记下当前要替换的格，供点击回调使用（_doReplacePanelImageSel 读取）
        this._rpCtx = { gid, i };
        const sections = this._renderPickBlocks(blocks, 'single', chosen, 'StoryboardModule._doReplacePanelImageSel');

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🔄 替换面板${i + 1}画面</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body sb-pick-body">
                <p class="form-hint">点击任意一张图，即可把它替换为本面板的画面（原四宫格大图不变，仅替换此面板的切分图）。每组发光框 = 一张四宫格 + 它的 4 张切分图；带高亮的是本格正在用的图。</p>
                ${sections}
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    // single 模式点击回调：从 _rpCtx 取出 gid/i，复用 _doReplacePanelImage 完成替换。
    _doReplacePanelImageSel(mediaId) {
        const ctx = this._rpCtx || {};
        if (ctx.gid == null) return;
        this._doReplacePanelImage(ctx.gid, ctx.i, mediaId);
    },

    async _doReplacePanelImage(gid, i, mediaId) {
        const src = Storage.getMediaById(this.projectId, mediaId);
        if (!src) { App.showToast('图像不存在', 'error'); return; }
        App.closeModal();
        // 复制一份为本面板专属切分图（ownerType=storyboards），避免与原图共用同一 mediaId 被联动删除。
        // src.data 已是服务器相对路径（非 data:），_addMedia 会原样保存，不会二次落盘。
        const copy = await Storage._addMedia(
            this.projectId, 'image', 'storyboards', gid + '_panel' + i, src.data, src.mime || null,
            { w: src.width || 0, h: src.height || 0 }
        );
        // 重新取最新工程，避免覆盖 _addMedia 内部已写入的 mediaLibrary
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g || !copy) { App.showToast('替换失败', 'error'); return; }
        if (!Array.isArray(g.panelImages)) g.panelImages = [null, null, null, null];
        g.panelImages[i] = copy.id;
        g.lastShownPanel = i;   // 列表缩略图顶层切到刚替换的这一格，立即体现变化
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.showToast(`已替换面板${i + 1}的画面，列表缩略图已更新到该格`, 'success');
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

    // 画面提示语默认文案：@图1=前一帧、@图2=后一帧，引导生成衔接二者的中间帧，并把卡片上的 local 提示语内容作为画面内容拼入。
    _defaultImgPrompt(g) {
        const local = (g && g.prompt ? g.prompt.trim() : '');
        const localPart = local ? `画面内容：${local}。` : '';
        return `@图1为前一帧，@图2为后一帧。请生成一张衔接二者的中间帧：在保持人物外形与服装、场景环境、光线方向与明暗、整体色调、镜头视角与景别连贯一致的前提下，让画面从 @图1 自然过渡到 @图2，过渡平滑、无跳变、无穿帮。${localPart}`;
    },

    // ===== 单分镜「生成」弹窗（参考四宫格生成弹窗样式）=====
    // 顶部画面提示语；下方「参考图清单」：每张带 @图N 标签 + 缩略图 + ✕ 移除；底部「＋ 添加参考图」入口。
    // 默认参考图：图1=时间轴前一帧、图2=后一帧（_neighborFrameIds 推算）；提示语与卡片 local 提示语共用 g.prompt。
    openSingleGenModal(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;

        // 弹窗内有序参考图列表（@图1、@图2… 即此顺序）：已选过沿用 g.refImageIds；否则默认 [前帧, 后帧]。
        let refIds = (g.refImageIds || []).map(v => parseInt(v)).filter(v => !isNaN(v));
        if (!refIds.length) {
            const { prevId, nextId } = this._neighborFrameIds(g);
            refIds = [prevId, nextId].filter(v => v != null).map(v => parseInt(v));
            refIds = Array.from(new Set(refIds));
        } else {
            refIds = Array.from(new Set(refIds));
        }
        this._sgCtx = { gid, refs: refIds };

        // 画面提示语（独立字段 g.imgPrompt）：已填过用它；否则用「@图1/@图2 + 拼入 local 提示语」的默认文案
        const promptVal = (g.imgPrompt && g.imgPrompt.trim()) ? g.imgPrompt : this._defaultImgPrompt(g);

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🎨 生成单分镜图</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body sb-pick-body">
                <div class="form-group">
                    <label class="form-label">画面提示语</label>
                    <textarea class="form-textarea" id="singleGenPrompt" style="min-height:90px" placeholder="描述要生成的画面…">${this.esc(promptVal)}</textarea>
                    <p class="form-hint" style="margin-top:0.3rem">开头按 <b>@图1=…、@图2=…</b> 引用下方参考图（下方清单的 @图序号即接口收到的顺序）。默认 @图1=前一帧、@图2=后一帧，可在下面移除/添加。</p>
                </div>
                <div class="form-group">
                    <div class="meta-header">
                        <span class="meta-label">📷 参考图清单</span>
                    </div>
                    <div id="singleGenRefList">${this._renderSingleGenRefs()}</div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" onclick="StoryboardModule._doSingleGen('${gid}')">▶ 开始生成</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    // 渲染单分镜生成弹窗的「参考图清单」：每张 @图N + 缩略图 + ✕ 移除；末尾「＋ 添加参考图」。
    _renderSingleGenRefs() {
        const ctx = this._sgCtx || { refs: [] };
        const refs = ctx.refs || [];
        const cells = refs.map((mid, i) => {
            const m = Storage.getMediaById(this.projectId, mid);
            const url = m ? Storage.mediaUrl(m.data) : '';
            const thumb = url ? `<img src="${url}" alt="参考图">` : `<div class="sb-fg-ref-miss">图已删除</div>`;
            return `<div class="sb-fg-ref-cell">
                <div class="sb-fg-ref-idx">@图${i + 1}</div>
                <div class="sb-fg-ref-thumb">${thumb}</div>
                <div class="sb-fg-ref-acts"><button class="btn-ghost btn-tiny" title="移除这张参考图（@图序号会自动顺延）" onclick="StoryboardModule._sgRemoveRef(${mid})">✕ 移除</button></div>
            </div>`;
        }).join('');
        const addBtn = `<div class="sb-fg-ref-add">
            <button class="btn-ghost btn-tiny" onclick="StoryboardModule._sgAddRef()">＋ 添加参考图（选已生成图/切分图）</button>
        </div>`;
        return `<div class="sb-fg-ref-grid">${cells || '<div class="form-hint">未选参考图，可点下方「添加参考图」选择</div>'}</div>${addBtn}`;
    },

    // 移除清单里的某张参考图
    _sgRemoveRef(mid) {
        const ctx = this._sgCtx; if (!ctx) return;
        mid = parseInt(mid);
        ctx.refs = (ctx.refs || []).filter(x => x !== mid);
        const host = document.getElementById('singleGenRefList');
        if (host) host.innerHTML = this._renderSingleGenRefs();
    },

    // 「添加参考图」：打开统一图选弹窗（多选，已在清单里的默认勾选），确定后并回清单（保留提示语）。
    _sgAddRef() {
        const ctx = this._sgCtx; if (!ctx) return;
        // 先把当前提示语暂存，避免切弹窗后丢失
        const ta = document.getElementById('singleGenPrompt');
        if (ta) ctx.prompt = ta.value;
        const all = this._allImageAssets();
        if (!all.length) { App.showToast('暂无可选图像，请先在人物/道具/场景页生成图，或生成四宫格切分图', 'info'); return; }
        const blocks = this._groupAssetsBySb(all);
        const chosen = new Set((ctx.refs || []).map(String));
        const sections = this._renderPickBlocks(blocks, 'multi', chosen);
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🖼️ 选择参考图（可多选，按勾选顺序作为 @图N）</h2><button class="modal-close" onclick="StoryboardModule.openSingleGenModal('${ctx.gid}')">×</button></div>
            <div class="modal-body sb-pick-body">
                <p class="form-hint">勾选要作为本单分镜参考的图。分镜图每行：四宫格 + 它的 4 张切分图。</p>
                ${sections}
            </div>
            <div class="modal-footer">
                <span class="rp-sel-count" id="pickSelCount" style="margin-right:auto;font-size:0.8rem;color:var(--t2)">已选 0 张</span>
                <button class="btn-secondary" onclick="StoryboardModule.openSingleGenModal('${ctx.gid}')">返回</button>
                <button class="btn-primary" onclick="StoryboardModule._sgConfirmAddRefs()">确定</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
        this._updatePickCount();
    },

    // 图选弹窗「确定」：把勾选结果按顺序并回清单，再回到生成弹窗
    _sgConfirmAddRefs() {
        const ctx = this._sgCtx; if (!ctx) return;
        const cells = document.querySelectorAll('#modalContent .sb-pick-cell input[type=checkbox]:checked');
        const ids = Array.from(cells).map(c => parseInt(c.value)).filter(v => !isNaN(v));
        ctx.refs = Array.from(new Set(ids));
        // 回到生成弹窗（会用 ctx.refs 渲染清单；提示语用暂存 ctx.prompt 或库里 g.prompt）
        this.openSingleGenModal(ctx.gid);
        // openSingleGenModal 会重置 ctx.refs 为库里值，故这里需把刚选的写回并重渲染
        this._sgCtx.refs = ctx.refs;
        if (ctx.prompt != null) {
            const ta = document.getElementById('singleGenPrompt');
            if (ta) ta.value = ctx.prompt;
        }
        const host = document.getElementById('singleGenRefList');
        if (host) host.innerHTML = this._renderSingleGenRefs();
    },

    // 弹窗「开始生成」：保存画面提示语（独立字段 g.imgPrompt，不覆盖 local 提示语 g.prompt）+ 清单参考图，关弹窗后调用生成。
    async _doSingleGen(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const ta = document.getElementById('singleGenPrompt');
        const prompt = ta ? ta.value.trim() : (g.imgPrompt || '');
        if (!prompt) { App.showToast('请先填写画面提示语', 'error'); return; }
        const ctx = this._sgCtx || { refs: [] };
        g.imgPrompt = prompt;
        g.refImageIds = (ctx.refs || []).slice();
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.closeModal();
        await this.genSingleImage(gid);
    },

    // ===== 单分镜「替换」：从历史/素材库选一张图，直接设为当前画面（不调模型）=====
    replaceSingleImage(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const all = this._allImageAssets();
        if (!all.length) { App.showToast('暂无可选图像，请先在人物/道具/场景页生成图，或生成四宫格', 'info'); return; }
        const blocks = this._groupAssetsBySb(all);
        const chosen = g.imageId != null ? new Set([String(g.imageId)]) : null;
        this._rsCtx = { gid };
        const sections = this._renderPickBlocks(blocks, 'single', chosen, 'StoryboardModule._doReplaceSingleSel');
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🔄 替换单分镜画面</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body sb-pick-body">
                <p class="form-hint">点击任意一张图，即可把它设为本单分镜的当前画面。带高亮的是当前正在用的图。</p>
                ${sections}
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },
    _doReplaceSingleSel(mediaId) {
        const ctx = this._rsCtx || {};
        if (ctx.gid == null) return;
        const src = Storage.getMediaById(this.projectId, mediaId);
        if (!src) { App.showToast('图像不存在', 'error'); return; }
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === ctx.gid);
        if (!g) return;
        g.imageId = parseInt(mediaId);
        g.imageError = '';
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.closeModal();
        App.showToast('已替换单分镜画面', 'success');
        this.render(this.projectId);
    },

    // ===== 单分镜：生成单图（走四宫格同一编辑接口，参考图=选中的所有参考图）=====
    async genSingleImage(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        // 生图用「画面提示语」g.imgPrompt（独立于 local 提示语 g.prompt）；未填则用拼了 local 内容的默认文案
        const imgPrompt = (g.imgPrompt && g.imgPrompt.trim()) ? g.imgPrompt.trim() : this._defaultImgPrompt(g);
        if (!imgPrompt) { App.showToast('请先填写画面提示语', 'error'); return; }

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
                prompt: imgPrompt,
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
        let splitOk = true;
        try { await this._splitFourGrid(g, Storage.mediaUrl(m.data)); }
        catch (e) { splitOk = false; g.fourGridError = '切分失败：' + (e && e.message ? e.message : e); }
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.showToast(splitOk ? '已设为当前四宫格并重新切分面板' : '已切换，但切分失败：' + g.fourGridError, splitOk ? 'success' : 'error');
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

    // ===== 用大模型优化单分镜的画面提示语（结合剧本作参考，仅替换文本，可一键恢复） =====
    async optimizeLocalPrompt(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const cur = (g.prompt || '').trim();
        if (!cur) { App.showToast('请先填写画面提示词再优化', 'info'); return; }
        const llm = SettingsModule.getLlmConfig();
        if (!llm.key) { App.showToast('请先在设置页填写文本大模型 API Key', 'error'); return; }

        const btn = document.getElementById('optBtn_' + gid);
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 优化中'; }
        try {
            const r = await API.post('/api/llm/optimize_prompt', {
                mode: 'optimize',
                prompt: cur,
                script: p.script || '',
                system_prompt: llm.optimizePrompt,
                api_url: llm.url, api_key: llm.key, model: llm.model,
            });
            if (!r.success || !r.text) throw new Error(r.error || '优化失败');
            // 备份原值（仅首次优化时备份，便于恢复到最初的原稿）
            if (g.promptBackup == null) g.promptBackup = cur;
            g.prompt = r.text;
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
            this.render(this.projectId);
            App.showToast('已用大模型优化提示语，可点「↩ 恢复」还原', 'success');
        } catch (e) {
            App.showToast('优化失败：' + (e.message || e), 'error');
            if (btn) { btn.disabled = false; btn.textContent = '✨ 优化'; }
        }
    },

    // 恢复优化前的原始提示语
    restoreLocalPrompt(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g || g.promptBackup == null) return;
        g.prompt = g.promptBackup;
        delete g.promptBackup;
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);
        App.showToast('已恢复原提示语', 'success');
    },

    // ===== 用大模型优化「四宫格组某个面板」的 local 提示语（结合剧本，仅替换文本，可恢复） =====
    async optimizePanelPrompt(gid, i) {
        i = parseInt(i, 10) || 0;
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        if (!Array.isArray(g.localPrompts)) g.localPrompts = ['', '', '', ''];
        const cur = (g.localPrompts[i] || '').trim();
        if (!cur) { App.showToast('请先填写该面板的 local 提示词再优化', 'info'); return; }
        const llm = SettingsModule.getLlmConfig();
        if (!llm.key) { App.showToast('请先在设置页填写文本大模型 API Key', 'error'); return; }

        const btn = document.getElementById('optBtn_' + gid + '_' + i);
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 优化中'; }
        try {
            const r = await API.post('/api/llm/optimize_prompt', {
                mode: 'optimize',
                prompt: cur,
                script: p.script || '',
                system_prompt: llm.optimizePrompt,
                api_url: llm.url, api_key: llm.key, model: llm.model,
            });
            if (!r.success || !r.text) throw new Error(r.error || '优化失败');
            if (!Array.isArray(g.localBackup)) g.localBackup = [null, null, null, null];
            if (g.localBackup[i] == null) g.localBackup[i] = cur;   // 仅首次优化时备份
            g.localPrompts[i] = r.text;
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
            this.render(this.projectId);
            App.showToast(`已优化面板${i + 1}的 local 提示语，可点「↩ 恢复」还原`, 'success');
        } catch (e) {
            App.showToast('优化失败：' + (e.message || e), 'error');
            if (btn) { btn.disabled = false; btn.textContent = '✨ 优化'; }
        }
    },

    // 恢复四宫格组某面板优化前的 local 提示语
    restorePanelPrompt(gid, i) {
        i = parseInt(i, 10) || 0;
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g || !Array.isArray(g.localBackup) || g.localBackup[i] == null) return;
        if (!Array.isArray(g.localPrompts)) g.localPrompts = ['', '', '', ''];
        g.localPrompts[i] = g.localBackup[i];
        g.localBackup[i] = null;
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);
        App.showToast(`已恢复面板${i + 1}的原 local 提示语`, 'success');
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

    // ===== 单分镜配音弹窗：选说话人（自动匹配音色）、改台词/语气，生成配音 =====
    openSingleAudioModal(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        const d = g.dialogue || {};
        // 与四宫格一致：按说话人自动匹配其「当前选中音色」
        const char = (p.characters || []).find(c => c.name === d.character);
        const refAudio = char ? Storage.getSelectedMedia(this.projectId, 'characters', char, 'audio') : null;
        const refUrl = refAudio ? Storage.mediaUrl(refAudio.data) : '';
        const curAud = g.audioId != null ? Storage.getMediaById(this.projectId, g.audioId) : null;
        const curUrl = curAud ? Storage.mediaUrl(curAud.data) : '';
        const charOptions = (p.characters || []).map(c => `<option value="${this.esc(c.name)}" ${c.name === d.character ? 'selected' : ''}>${this.esc(c.name)}</option>`).join('');

        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">🔊 单分镜配音</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-col">
                        <label class="form-label">说话人</label>
                        <select class="form-input" id="ssChar" onchange="StoryboardModule.openSingleAudioModal('${gid}')">
                            <option value="">— 不指定 —</option>
                            ${charOptions}
                        </select>
                    </div>
                    <div class="form-col">
                        <label class="form-label">语气 / 风格</label>
                        <input class="form-input" id="ssTone" value="${this.esc(d.tone || '')}" placeholder="例如：低沉、温柔、激动">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">台词文本</label>
                    <textarea class="form-textarea" id="ssText" style="min-height:72px" placeholder="本分镜要说的话">${this.esc(d.text || '')}</textarea>
                </div>
                <div class="sb-audio-ref">
                    <span class="sb-audio-ref-label">参考音色 ${char ? `· ${this.esc(char.name)}` : ''}</span>
                    ${refUrl
                        ? `<audio controls preload="none" src="${refUrl}"></audio>`
                        : (char
                            ? `<span class="sb-audio-ref-miss">⚠️ 该人物尚无音色，请先到人物页生成音频</span>`
                            : `<span class="sb-audio-ref-miss">请先选择说话人</span>`)}
                </div>
                ${this._emotionPanelHtml('ss')}
                ${curUrl ? `<div class="sb-audio-ref"><span class="sb-audio-ref-label">当前配音</span><audio controls preload="none" src="${curUrl}"></audio>${App.audioDragHandle(curUrl, `分镜配音_${gid}.${((curAud && curAud.mime) || '').includes('mpeg') ? 'mp3' : ((curAud && curAud.mime) || '').includes('flac') ? 'flac' : 'wav'}`, '拖出')}</div>` : ''}
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
const charName = (document.getElementById('ssChar') || {}).value || '';
if (!text.trim()) { App.showToast('请先填写台词', 'error'); return; }
// 回写说话人/台词/语气
g.dialogue = Object.assign({}, g.dialogue, { character: charName, text: text.trim(), tone: tone.trim() });
Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });

// 与四宫格一致：按说话人自动匹配其「当前选中音色」
const char = (p.characters || []).find(c => c.name === charName);
if (!char) { App.showToast('请选择说话人', 'error'); return; }
const refAud = Storage.getSelectedMedia(this.projectId, 'characters', char, 'audio');
if (!refAud) { App.showToast(`「${char.name}」尚未生成音色，请先到人物页生成`, 'error'); return; }
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
workflow: (Storage.getSettings().voiceSettings || {}).cloneWorkflow || 'vocpm',
emotions: this._collectEmotions(),
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
            <div class="sb-local-thumb-cell">
                <div class="sb-local-thumb" onclick="${pUrl ? `CharacterModule.openImageZoom('${pUrl}','${zoomTitle}','')` : ''}">
                    ${pUrl ? `<img src="${pUrl}" alt="面板${i + 1}">` : `<span class="sb-local-no">${i + 1}</span>`}
                    <span class="sb-local-badge">${i + 1}</span>
                </div>
                <div class="sb-local-thumb-acts">
                    <button class="btn-ghost btn-tiny sb-local-replace" title="从以往生成的任意图像中选一张替换本面板的画面" onclick="event.stopPropagation();StoryboardModule.replacePanelImage('${g.id}',${i})">🔄 替换</button>
                    <button class="btn-ghost btn-tiny sb-local-insert" title="在本面板后插入一个独立单分镜（会把本组从这格拆开）" onclick="event.stopPropagation();StoryboardModule.insertSingleInGroup('${g.id}',${i})">＋ 单分镜</button>
                </div>
            </div>
            <div class="sb-local-main">
                <div class="sb-local-prompt-head">
                    <span class="sb-local-prompt-label">local 提示词</span>
                    <span class="sb-prompt-actions">
                        <button class="btn-ghost btn-tiny" id="optBtn_${g.id}_${i}" title="用大模型结合剧本优化这条 local 提示语" onclick="StoryboardModule.optimizePanelPrompt('${g.id}',${i})">✨ 优化</button>
                        ${(g.localBackup && g.localBackup[i] != null) ? `<button class="btn-ghost btn-tiny" title="恢复优化前的 local 提示语" onclick="StoryboardModule.restorePanelPrompt('${g.id}',${i})">↩ 恢复</button>` : ''}
                    </span>
                </div>
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
                ${this._renderTransRow(g, i)}
            </div>
        </div>`;
    },

    // 转场描述行：独立于 local 提示词，单独展示在每个面板下方（4 个面板都展示）。
    // 第 4 面板的转场接下一组第 1 面板（多个四宫格连续生成时需要）；最后一组的最后一个可由用户自行删除。
    // 合成视频时，该文本会作为「无图无音频的纯文本段」插到本面板与下一面板之间，仅给 API 填 local 提示词。
    _renderTransRow(g, i) {
        const trans = (g.shotTransitions || [])[i] || '';
        const label = i < 3 ? `转场${i + 1}→${i + 2}` : '转场→下一组';
        return `<div class="sb-trans-row" title="镜头语言 / 与下一面板（第4面板为下一组首面板）之间的转场。合成视频时作为两图之间的纯文本过渡段（无图、无音频）送入。">
            <span class="sb-trans-ic">🎞️ ${label}</span>
            ${InlineEdit.field(trans, {
                single: true,
                placeholder: '点击填写到下一面板的转场 / 镜头语言（如：镜头由中景推近至特写、硬切到对话另一方…）。留空则不插入转场段。',
                className: 'sb-trans-text clamp-1',
                data: { edit: 'sb-panel', gid: g.id, panel: i, field: 'shotTransition' } })}
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

    // 单分镜版「说话人下拉」：与 _panelCharSelect 同款，选人物→自动匹配其音色；缺音色给⚠️提示。
    // 单分镜的台词归属在 g.dialogue（对象，非数组），故单独一个方法。
    _singleCharSelect(g, cur) {
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
        const warn = (cur && !hasVoice) ? '<span class="sb-dlg-novoice" title="该人物尚无音色，请先到人物页生成音频">⚠️</span>' : '';
        return `<div class="sb-dlg-who-wrap">
            <select class="sb-dlg-who-select ${cur ? '' : 'is-empty'}" onchange="StoryboardModule.setSingleCharacter('${g.id}',this.value)">${opts}</select>
            ${warn}
        </div>`;
    },

    // 单分镜下拉选说话人 → 写回 g.dialogue.character（配音时按此名字自动匹配人物音色）
    setSingleCharacter(gid, name) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        if (!g.dialogue) g.dialogue = { character: '', text: '', tone: '' };
        g.dialogue.character = name || '';
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this.render(this.projectId);
    },

    // 单分镜「▶ 播放 / ⏸」：播放本单分镜的成品配音（与其它行内播放互斥）
    toggleSinglePlay(gid) {
        const a = document.getElementById('siAaudio_' + gid);
        const b = document.getElementById('siAplay_' + gid);
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

    // 全部取消：把所有组中当前『已勾选合成』的分镜全部取消勾选（不改变已标记状态）
    unselectAllGlobal() {
        const p = Storage.getProject(this.projectId);
        const groups = p.storyboardGroups || [];
        if (!groups.length) return;
        let count = 0;
        groups.forEach(g => {
            if (g.single) {
                if (g.selected !== false) { g.selected = false; count++; }
                return;
            }
            if (!Array.isArray(g.panelSelected)) g.panelSelected = [true, true, true, true];
            [0, 1, 2, 3].forEach(i => {
                if (g.panelSelected[i] !== false) { g.panelSelected[i] = false; count++; }
            });
        });
        if (!count) { App.showToast('当前没有已勾选『合成视频』的分镜', 'info'); return; }
        Storage.updateProject(this.projectId, { storyboardGroups: groups });
        App.showToast(`已取消 ${count} 个分镜的勾选`, 'success');
        this.render(this.projectId);
    },

    // 🎯 定位首个已选：滚动到第一个『已勾选合成视频』的分镜卡片并高亮一下。
    // 勾选判断与 openTimeline/unselectAllGlobal 一致：单分镜 selected !== false；四宫格任一面板 panelSelected[i] !== false。
    jumpToFirstSelected() {
        const p = Storage.getProject(this.projectId);
        const groups = p.storyboardGroups || [];
        const target = groups.find(g => g.single
            ? (g.selected !== false)
            : [0, 1, 2, 3].some(i => !(g.panelSelected && g.panelSelected[i] === false)));
        if (!target) { App.showToast('当前没有勾选『合成视频』的分镜', 'info'); return; }
        const el = document.getElementById('sbRow_' + target.id);
        if (!el) { App.showToast('未找到该分镜卡片', 'error'); return; }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // 高亮一下：加类，动画结束后移除（可重复触发）
        el.classList.remove('sb-row-flash');
        // 强制重排以便重复点击能再次触发动画
        void el.offsetWidth;
        el.classList.add('sb-row-flash');
        setTimeout(() => el.classList.remove('sb-row-flash'), 1800);
    },

    // 禁用/启用转场：禁用后合成视频时不再拼接转场段（transition 文本/时长清零）；未禁用时保持现状
    toggleDisableTransition() {
        const next = !Storage.getSettings().disableTransition;
        Storage.saveSettings({ disableTransition: next });
        App.showToast(next ? '已禁用转场：合成时不再插入转场段' : '已恢复转场：合成时按各段设置插入转场段', next ? 'info' : 'success');
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
                <div class="form-row" style="display:flex;gap:.75rem;flex-wrap:wrap">
                    <div class="form-group" style="flex:2;min-width:220px">
                        <label class="form-label">视觉风格（填入提示词的 {{风格}}，留空则按剧本氛围自定）</label>
                        <input type="text" class="form-input" id="sbGenStyle" placeholder="如：电影级真实感，自然光照，真人演员 / 日系动画 / 赛博朋克" value="${this.esc(s.storyboardStyle || '')}">
                    </div>
                    <div class="form-group" style="flex:1;min-width:120px">
                        <label class="form-label">输出语言（{{语言}}）</label>
                        <select class="form-input" id="sbGenLang">
                            <option value="英文" ${(s.storyboardLang || '英文') === '英文' ? 'selected' : ''}>英文（仅对白中文）</option>
                            <option value="中文" ${s.storyboardLang === '中文' ? 'selected' : ''}>中文</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">分镜提取提示词（可临时修改，默认取设置；其中 {{风格}}/{{语言}} 会用上方填写值替换）</label>
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
        // 读取风格/语言，替换提示词里的 {{风格}}/{{语言}} 占位符，并记住为下次默认
        const style = (document.getElementById('sbGenStyle') || {}).value || '';
        const lang = ((document.getElementById('sbGenLang') || {}).value === '中文') ? '中文' : '英文';
        const styleVal = style.trim() || '按剧本氛围自定一种统一风格';
        Storage.saveSettings({ storyboardStyle: style.trim(), storyboardLang: lang });
        const rawPrompt = document.getElementById('sbGenPrompt').value.trim();
        const prompt = rawPrompt.replace(/\{\{风格\}\}/g, styleVal).replace(/\{\{语言\}\}/g, lang);
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

    // ⏹ 停止：前端清任务/停轮询/停计时器并恢复按钮，同时调用 /api/sb_cancel
    // 真实杀掉后台 Claude Code 进程树（释放 claude_output.txt 占用），可立即重新生成。
    async stopGenerate() {
        const t = this._loadGenTask();
        if (!t) return;
        const ok = await App.confirm({
            title: '⏹ 停止生成',
            message: '停止本次生成？\n\n会立即终止后台的 Claude Code 进程并恢复「智能生成分镜」按钮，可马上重新生成。',
            okText: '停止生成',
            cancelText: '继续等待',
            danger: true,
        });
        if (!ok) return;
        this._genPolling = false;
        this._clearGenTask();
        this._stopGenMainTimer();
        // 真实打断：通知后端杀掉 Claude Code 进程树，释放 claude_output.txt 占用
        if (t.taskId) {
            try { await API.post('/api/sb_cancel', { task_id: t.taskId }); } catch (e) {}
        }
        // 关闭可能开着的执行弹窗
        const out = document.getElementById('sbGenOutput');
        if (out) App.closeModal();
        App.showToast('⏹ 已停止本次生成', 'info');
        if (this.projectId) this.render(this.projectId);
    },

    // IndexTTS-2 情感配置：8 维（与后端 INDEXTTS_EMOTION_KEYS 一致），范围 0~1.4
    _indexttsEmotions: { Happy: 0, Angry: 0, Sad: 0, Fear: 0, Hate: 0, Low: 0, Surprise: 0, Neutral: 0 },
    _indexttsEmotionMeta: [
        { key: 'Happy', label: '😄 高兴' },
        { key: 'Angry', label: '😠 愤怒' },
        { key: 'Sad', label: '😢 悲伤' },
        { key: 'Fear', label: '😱 恐惧' },
        { key: 'Hate', label: '😤 厌恶' },
        { key: 'Low', label: '😔 低落' },
        { key: 'Surprise', label: '😲 惊讶' },
        { key: 'Neutral', label: '😐 平静' },
    ],

    // 是否当前使用 IndexTTS-2 工作流（决定配音弹窗是否显示情感滑块）
    _isIndexTTS() {
        return ((Storage.getSettings().voiceSettings || {}).cloneWorkflow || 'vocpm') === 'indextts';
    },

    // 生成情感滑块面板 HTML（仅 IndexTTS-2 显示）。inputId 前缀避免多弹窗冲突。
    _emotionPanelHtml(prefix) {
        if (!this._isIndexTTS()) return '';
        const cur = this._indexttsEmotions || {};
        const rows = this._indexttsEmotionMeta.map(m => {
            const v = Math.max(0, Math.min(1.4, Number(cur[m.key]) || 0));
            return `<div class="sb-emo-row">
                <span class="sb-emo-label">${m.label}</span>
                <input type="range" class="sb-emo-slider" min="0" max="1.4" step="0.05" value="${v}"
                    oninput="StoryboardModule.onEmotionInput('${m.key}', this.value, '${prefix}')">
                <input type="number" class="sb-emo-num" id="${prefix}_emo_${m.key}" min="0" max="1.4" step="0.05" value="${v}"
                    oninput="StoryboardModule.onEmotionInput('${m.key}', this.value, '${prefix}')">
            </div>`;
        }).join('');
        return `<div class="sb-emo-panel">
            <div class="sb-emo-title">🎭 情感调节 <span class="sb-emo-hint">0~1.4，可多选混合；全 0 时为参考音频自带情感</span>
                <button type="button" class="sb-emo-reset" onclick="StoryboardModule.resetEmotions('${prefix}')">清零</button>
            </div>
            <div class="sb-emo-grid">${rows}</div>
        </div>`;
    },

    // 情感滑块/输入框联动：同步另一个控件 + 内存状态
    onEmotionInput(key, val, prefix) {
        let v = Number(val);
        if (!isFinite(v)) v = 0;
        v = Math.max(0, Math.min(1.4, v));
        this._indexttsEmotions[key] = v;
        // 同步同行的 slider / number
        const num = document.getElementById(`${prefix}_emo_${key}`);
        if (num && num.value !== String(v)) num.value = v;
        const panel = num && num.closest('.sb-emo-row');
        if (panel) {
            const slider = panel.querySelector('.sb-emo-slider');
            if (slider && Number(slider.value) !== v) slider.value = v;
        }
    },

    resetEmotions(prefix) {
        Object.keys(this._indexttsEmotions).forEach(k => { this._indexttsEmotions[k] = 0; });
        this._indexttsEmotionMeta.forEach(m => {
            const num = document.getElementById(`${prefix}_emo_${m.key}`);
            if (num) num.value = 0;
            const row = num && num.closest('.sb-emo-row');
            const slider = row && row.querySelector('.sb-emo-slider');
            if (slider) slider.value = 0;
        });
    },

    // 取当前情感向量副本（提交时携带；非 IndexTTS-2 返回 undefined 不占用 payload）
    _collectEmotions() {
        if (!this._isIndexTTS()) return undefined;
        return { ...this._indexttsEmotions };
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
    // 解析失败 / 字段缺失都会给出明确提示。返回是否导入成功（供粘贴弹窗据此关闭）。
    _parseAndImportJson(text) {
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            App.showToast('❌ JSON 解析失败：内容不是合法的 JSON', 'error');
            return false;
        }
        // 兼容多种字段命名：分镜 / storyboards；person / persons / 人物
        const storyboards = data['分镜'] || data.storyboards || data.storyboard || null;
        const person = data.person || data.persons || data['人物'] || {};
        if (!storyboards || typeof storyboards !== 'object' || !Object.keys(storyboards).length) {
            App.showToast('⚠️ 未识别到分镜数据：JSON 需包含『分镜』（或 storyboards）字段', 'error');
            return false;
        }
        try {
            const stat = this._importGroups(person, storyboards) || {};
            App.showToast(`✅ 已导入：${stat.groupCount || 0} 组四宫格 · 共 ${stat.shots || 0} 个分镜`, 'success');
            if (this.projectId) this.render(this.projectId);
            return true;
        } catch (e) {
            console.error(e);
            App.showToast('❌ 导入失败：' + (e.message || '分镜结构异常'), 'error');
            return false;
        }
    },

    // 📋 粘贴 JSON：弹出一个文本框，直接粘贴分镜 JSON 文本解析导入（无需保存成文件）
    openPasteJsonModal() {
        const mc = document.getElementById('modalContent');
        if (!mc) { App.showToast('❌ 无法打开弹窗', 'error'); return; }
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">📋 粘贴分镜 JSON 导入</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body">
                <div class="form-hint" style="margin-bottom:8px">把分镜 JSON 文本直接粘贴到下方（与「上传 JSON」同格式：需包含 <code>分镜</code>（或 <code>storyboards</code>）字段，可选 <code>person</code> / <code>人物</code>），点「解析导入」即可，无需保存成文件。</div>
                <textarea id="sbPasteJsonInput" class="form-input" style="width:100%;min-height:280px;font-family:monospace;font-size:12px;line-height:1.5;white-space:pre;overflow:auto" placeholder='粘贴 JSON，例如：\n{\n  "person": { ... },\n  "分镜": {\n    "1": { ... },\n    "2": { ... }\n  }\n}'></textarea>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" onclick="StoryboardModule.confirmPasteJson()">解析导入</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
        // 自动聚焦文本框，方便直接粘贴
        setTimeout(() => { const ta = document.getElementById('sbPasteJsonInput'); if (ta) ta.focus(); }, 50);
    },

    // 粘贴 JSON 弹窗：点「解析导入」后取文本框内容，复用 _parseAndImportJson 解析。
    // 解析成功后关闭弹窗；失败则保留弹窗便于用户修正后重试。
    confirmPasteJson() {
        const ta = document.getElementById('sbPasteJsonInput');
        const text = ta ? (ta.value || '').trim() : '';
        if (!text) { App.showToast('⚠️ 请先粘贴 JSON 文本', 'error'); return; }
        // _parseAndImportJson 内部已处理解析失败/字段缺失的 toast 提示，并返回是否成功
        if (this._parseAndImportJson(text)) App.closeModal();
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
                shotTransitions: Array.isArray(sb.shot_transitions) ? sb.shot_transitions.slice(0, 4) : ['', '', '', ''],
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

    // 点击「🔍 查看完整」：弹窗只读显示本组四宫格图像提示词（nano）的完整内容（不影响就地编辑）
    viewNanoFull(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        // 优先取配置弹窗中文本框的实时内容（可能用户刚编辑还未失焦保存），否则回退 storage
        const live = (document.getElementById('fgPrompt') || {}).value;
        const text = ((live != null ? live : (g.nanoPrompt || '')) || '').trim();
        if (!text) { App.showToast('该组暂无四宫格生成提示词', 'info'); return; }
        App.confirm({ title: '🎨 四宫格生成提示词', message: text, okText: '知道了', cancelText: '关闭' });
    },

    // 把文本里的「面板X / 面板XX」高亮为加粗深红（先 HTML 转义再包裹，避免 XSS / 标签注入）
    _highlightPanels(text) {
        const esc = this.esc((text || ''));
        // 匹配「面板」后跟 1~2 位数字（如 面板1、面板12）；保留换行展示
        return esc
            .replace(/面板\s*\d{1,2}/g, m => `<span class="sb-nano-panel">${m}</span>`)
            .replace(/\n/g, '<br>');
    },

    // 点击只读高亮层 → 切换为可编辑 textarea（自动展开高度），聚焦
    _fgNanoEdit() {
        const view = document.getElementById('fgNanoView');
        const ta = document.getElementById('fgPrompt');
        if (!view || !ta) return;
        view.style.display = 'none';
        ta.style.display = 'block';
        this._fgNanoAutoGrow(ta);
        ta.focus();
        // 光标移到末尾
        try { const n = ta.value.length; ta.setSelectionRange(n, n); } catch (e) {}
    },

    // textarea 失焦 → 保存并切回只读高亮层（重渲染高亮内容）
    _fgNanoBlur(gid) {
        const view = document.getElementById('fgNanoView');
        const ta = document.getElementById('fgPrompt');
        if (!view || !ta) return;
        // 保存（_saveFgPrompt 内部会判断是否变化）
        this._saveFgPrompt(gid, ta.value);
        const val = ta.value || '';
        view.innerHTML = this._highlightPanels(val) || '<span class="sb-nano-empty">点击填写四宫格生成提示词…</span>';
        ta.style.display = 'none';
        view.style.display = 'block';
    },

    // textarea 输入时自动撑高（最高 360px 后内部滚动）
    _fgNanoAutoGrow(ta) {
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight + 2, 360) + 'px';
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

                ${(() => {
                    const prev = !g.single ? this._prevGroupLastImage(g) : null;
                    if (!prev) return '';
                    const disabled = !!g.prevLinkDisabled;
                    const prevStatus = prev.url
                        ? `✅ 第${prev.groupNo}组四宫格就绪`
                        : `⚠️ 第${prev.groupNo}组尚无四宫格`;
                    // 取上一个四宫格的画面内容（nano_banana_prompt），用于写入默认衔接要求
                    const lastLocal = this._prevGroupLastLocal(g);
                    // 默认衔接要求：带上上一个四宫格的画面内容，并说明由下游模型按四宫格要求自行决定是否参考
                    const defaultNote = this._buildPrevLinkNote(lastLocal);
                    // textarea 默认值：用户编辑过则用其值，否则用默认衔接要求
                    const noteVal = (g.prevLinkNote != null && g.prevLinkNote !== '') ? g.prevLinkNote : defaultNote;
                    return `
                    <div class="form-group sb-fg-prev0 ${disabled ? 'sb-fg-prev0-disabled' : ''}" id="fgPrevLinkArea">
                        <div class="sb-fg-prev0-head">
                            <span class="form-label">@图0 · 上一组四宫格 · 衔接要求（可编辑）</span>
                            <span class="sb-fg-prev0-st">${prevStatus}</span>
                            ${disabled ? '<span class="sb-fg-prev0-off">（已移除，不参与衔接）</span>' : ''}
                        </div>
                        <textarea class="form-textarea sb-fg-prev0-ta" id="fgPrevLinkNote"
                            style="min-height:72px;color:var(--t1);font-size:0.82rem;line-height:1.5;resize:vertical;${disabled ? 'opacity:.4;pointer-events:none;background:var(--bg2);color:var(--t3)' : ''}"
                            ${disabled ? 'disabled' : ''}
                            onchange="StoryboardModule._saveFgPrevLinkNote('${gid}', this.value)"
                        >${this.esc(noteVal)}</textarea>
                    </div>`;
                })()}

                <div class="form-group">
                    <label class="form-label">四宫格生成提示词（nano，可改）</label>
                    ${(() => {
                        const val = g.nanoPrompt || g.globalPrompt || '';
                        return `
                        <div class="sb-nano-box" id="fgNanoBox">
                            <div class="sb-nano-view" id="fgNanoView" title="点击编辑提示词"
                                onclick="StoryboardModule._fgNanoEdit()">${this._highlightPanels(val) || '<span class="sb-nano-empty">点击填写四宫格生成提示词…</span>'}</div>
                            <textarea class="form-textarea sb-nano-ta" id="fgPrompt" style="display:none"
                                onblur="StoryboardModule._fgNanoBlur('${gid}')"
                                oninput="StoryboardModule._fgNanoAutoGrow(this)"
                                onchange="StoryboardModule._saveFgPrompt('${gid}', this.value)">${this.esc(val)}</textarea>
                        </div>`;
                    })()}
                    <p class="form-hint" style="margin-top:0.3rem">提示词开头应按 <b>@图1=…、@图2=…</b> 顺序声明参考图，下方列表的索引就是接口收到的顺序（@图0 为额外衔接图，不占此序号）。<b style="color:var(--err)">面板X</b> 会高亮标出；点击文本框即可编辑、自动展开完整内容。</p>
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

    // 弹窗里改了 @图0 衔接说明 → 立即写回 storage
    _saveFgPrevLinkNote(gid, val) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        g.prevLinkNote = (val || '').trim();
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
    },

    // 构造默认衔接要求：带上一组四宫格的画面内容（nano_banana_prompt），并说明由下游模型按四宫格要求自行决定是否参考
    _buildPrevLinkNote(lastLocal) {
        const lp = (lastLocal || '').trim();
        const lpPart = lp ? `上一个四宫格画面内容为：【${lp}】。` : '';
        return `@图0 是上一个四宫格的成品图。${lpPart}请根据下方四宫格要求，自行决定是否参考 @图0：若需衔接，则让本组第 1 格在上一个四宫格的画面基础上自然延续，保持人物外形与服装、人物在画面中所处的位置与朝向、场景环境、光线方向与明暗、整体色调，以及镜头视角与景别的连贯一致，使本组宫格之间以及与上一个四宫格的过渡平滑流畅、无跳变、无穿帮。`;
    },

    // 取某组用于默认衔接要求的「上一个四宫格」画面内容：优先上一组四宫格提示词 nano_banana_prompt；
    // 上一组若是单分镜，则回退其 globalPrompt / prompt。
    _prevGroupLastLocal(g) {
        const prev = this._prevGroupLastImage(g);
        if (!prev || !prev.groupNo) return '';
        const pg = (Storage.getProject(this.projectId).storyboardGroups || [])[prev.groupNo - 1];
        if (!pg) return '';
        if (pg.single) return (pg.globalPrompt || pg.prompt || '');
        // 四宫格组：用整张四宫格的画面提示词
        if (pg.nanoPrompt && pg.nanoPrompt.trim()) return pg.nanoPrompt.trim();
        // 兜底：globalPrompt 或最后一个 local_prompt
        const lp = (pg.localPrompts || []);
        return (pg.globalPrompt || lp[3] || lp[lp.length - 1] || '');
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
        const grid = assets.map(a => {
            // 「上一组四宫格」衔接图：独立渲染（与人物/道具/场景区分），缺失时高亮提示
            if (a.prevLink) {
                const thumb = a.url
                    ? `<img src="${a.url}" alt="上一组四宫格">`
                    : `<div class="sb-fg-ref-miss">上一组第${a.prevGroupNo || ''}组<br>尚无四宫格图</div>`;
                const acts = `<button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgRemovePrevLink('${gid}')" title="不把上一组四宫格作为参考图（@图序号会自动顺延）">✕ 移除衔接</button>`;
                return `<div class="sb-fg-ref-cell is-prev ${a.missing ? 'is-miss' : ''}">
                    <div class="sb-fg-ref-idx">@图${a.idx}</div>
                    <div class="sb-fg-ref-thumb">${thumb}</div>
                    <div class="sb-fg-ref-name" title="上一组的四宫格成品图，用于宫格间衔接">🔗 上一组四宫格</div>
                    <div class="sb-fg-ref-type">${a.missing ? '<span style="color:var(--err)">⚠️ 缺四宫格</span>' : '衔接 · 自动'}</div>
                    <div class="sb-fg-ref-acts">${acts}</div>
                </div>`;
            }
            const typeIcon = a.type === 'character' ? '👤' : (a.type === 'prop' ? '🔧' : (a.type === 'scene' ? '🏞️' : '📌'));
            const typeLab = a.extra ? '附加' : this._typeLabel(a.type);
            const thumb = a.url
                ? `<img src="${a.url}" alt="${this.esc(a.name)}">`
                : `<div class="sb-fg-ref-miss">缺图</div>`;
            const mk = a.manualKey ? encodeURIComponent(a.manualKey) : '';
            const isManual = !a.extra && !a.missing && a.manualKey && (((Storage.getProject(this.projectId).storyboardGroups || []).find(x => x.id === gid) || {}).refManual || {})[a.manualKey] != null;

            // 操作按钮区
            let actions = '';
            if (a.extra) {
                // 额外参考图：可删除
                actions = `<button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgRemoveExtra('${gid}','${a.extraId}')">✕ 删除</button>`;
            } else if (a.missing) {
                // 缺图：选已生成图 / 上传（手动补到 refManual[key]）+ 可整项移除
                actions = `<button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgPickForMissing('${gid}','${mk}')">🖼️ 选图</button>
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgUploadForMissing('${gid}','${mk}')">📁 上传</button>
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgExcludeRef('${gid}','${mk}')">✕ 移除</button>`;
            } else if (isManual) {
                // 手动补过的图：可更换 / 清除（恢复缺图状态）+ 可整项移除
                actions = `<button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgPickForMissing('${gid}','${mk}')">🔄 更换</button>
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgClearManual('${gid}','${mk}')">↺ 清除</button>
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgExcludeRef('${gid}','${mk}')">✕ 移除</button>`;
            } else {
                // 自动识别的人物/道具/场景图：可整项移除（@图索引会自动重排）
                actions = `<button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgExcludeRef('${gid}','${mk}')">✕ 移除</button>`;
            }

            return `<div class="sb-fg-ref-cell ${a.missing ? 'is-miss' : ''} ${a.extra ? 'is-extra' : ''}">
                <div class="sb-fg-ref-idx">@图${a.idx}</div>
                <div class="sb-fg-ref-thumb">${thumb}</div>
                <div class="sb-fg-ref-name" title="${this.esc(a.name)}">${typeIcon} ${this.esc(a.name)}</div>
                <div class="sb-fg-ref-type">${typeLab}${isManual ? ' · 手动' : ''}</div>
                ${actions ? `<div class="sb-fg-ref-acts">${actions}</div>` : ''}
            </div>`;
        }).join('');

        // 底部「添加参考图」入口（追加额外参考图，不依赖人物/道具/场景库）
        const gObj = (Storage.getProject(this.projectId).storyboardGroups || []).find(x => x.id === gid) || {};
        const excludedCount = (gObj.refExcluded || []).length;
        // 「恢复上一镜衔接」：仅当本组是非首组四宫格、且衔接被用户移除过时显示
        const canPrevLink = !gObj.single && this._prevGroupLastImage(gObj);
        const showRestorePrev = canPrevLink && gObj.prevLinkDisabled;
        const addBtn = `<div class="sb-fg-ref-add">
            <button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgAddExtra('${gid}')">＋ 添加参考图（选已生成图/切割分镜）</button>
            <button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgUploadExtra('${gid}')">📁 上传新图</button>
            ${showRestorePrev ? `<button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgRestorePrevLink('${gid}')">🔗 恢复上一镜衔接</button>` : ''}
            ${excludedCount ? `<button class="btn-ghost btn-tiny" onclick="StoryboardModule._fgRestoreExcluded('${gid}')">↺ 恢复已移除（${excludedCount}）</button>` : ''}
        </div>`;

        return `<div class="sb-fg-ref-grid">${grid || '<div class="form-hint">未识别到任何参考资产</div>'}</div>${addBtn}`;
    },

    // ===== 缺图素材：选择已生成图像（含切割分镜）补到 refManual[key] =====
    _fgPickForMissing(gid, encKey) {
        const key = decodeURIComponent(encKey || '');
        if (!key) return;
        this._fgImagePicker(gid, '🖼️ 为缺图素材选择参考图', (mid) => {
            const p = Storage.getProject(this.projectId);
            const g = (p.storyboardGroups || []).find(x => x.id === gid);
            if (!g) return;
            g.refManual = g.refManual || {};
            g.refManual[key] = mid;
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
            App.showToast('✅ 已补充参考图', 'success');
            this._showFgConfigModal(gid);
            this.render(this.projectId);
        });
    },

    // 缺图素材：上传一张图作为该素材的参考图（不写入人物/道具/场景库，仅作分镜临时参考）
    _fgUploadForMissing(gid, encKey) {
        const key = decodeURIComponent(encKey || '');
        if (!key) return;
        this._fgUploadToLib(gid, (mid) => {
            const p = Storage.getProject(this.projectId);
            const g = (p.storyboardGroups || []).find(x => x.id === gid);
            if (!g) return;
            g.refManual = g.refManual || {};
            g.refManual[key] = mid;
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
            App.showToast('✅ 已上传并补充参考图', 'success');
            this._showFgConfigModal(gid);
            this.render(this.projectId);
        });
    },

    // 清除手动补图，恢复缺图状态
    _fgClearManual(gid, encKey) {
        const key = decodeURIComponent(encKey || '');
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g || !g.refManual) return;
        delete g.refManual[key];
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this._showFgConfigModal(gid);
        this.render(this.projectId);
    },

    // ===== 额外参考图：添加（选已生成图）/上传/删除 =====
    _fgAddExtra(gid) {
        this._fgImagePicker(gid, '＋ 添加附加参考图', (mid) => {
            const p = Storage.getProject(this.projectId);
            const g = (p.storyboardGroups || []).find(x => x.id === gid);
            if (!g) return;
            g.extraRefIds = g.extraRefIds || [];
            if (!g.extraRefIds.map(String).includes(String(mid))) g.extraRefIds.push(mid);
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
            App.showToast('✅ 已添加参考图', 'success');
            this._showFgConfigModal(gid);
            this.render(this.projectId);
        });
    },

    _fgUploadExtra(gid) {
        this._fgUploadToLib(gid, (mid) => {
            const p = Storage.getProject(this.projectId);
            const g = (p.storyboardGroups || []).find(x => x.id === gid);
            if (!g) return;
            g.extraRefIds = g.extraRefIds || [];
            g.extraRefIds.push(mid);
            Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
            App.showToast('✅ 已上传并添加参考图', 'success');
            this._showFgConfigModal(gid);
            this.render(this.projectId);
        });
    },

    _fgRemoveExtra(gid, mid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        g.extraRefIds = (g.extraRefIds || []).filter(x => String(x) !== String(mid));
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        this._showFgConfigModal(gid);
        this.render(this.projectId);
    },

    // 移除某个自动识别的参考图（人物/道具/场景）：加入排除列表，后续 @图索引自动重排。
    // 同时清掉它可能存在的手动补图，保持数据干净。
    _fgExcludeRef(gid, encKey) {
        const key = decodeURIComponent(encKey || '');
        if (!key) return;
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        g.refExcluded = g.refExcluded || [];
        if (!g.refExcluded.includes(key)) g.refExcluded.push(key);
        if (g.refManual && g.refManual[key] != null) delete g.refManual[key];
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.showToast('已移除该参考图，@图索引已重排', 'success');
        this._showFgConfigModal(gid);
        this.render(this.projectId);
    },

    // 恢复本组所有被移除的自动识别参考图
    _fgRestoreExcluded(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        g.refExcluded = [];
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.showToast('已恢复被移除的参考图', 'success');
        this._showFgConfigModal(gid);
        this.render(this.projectId);
    },

        // 移除「上一组四宫格」衔接图（标记 prevLinkDisabled）：@图序号自动顺延
    _fgRemovePrevLink(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        g.prevLinkDisabled = true;
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.showToast('已移除上一镜衔接，本组将不再以上一组四宫格作为 @图0', 'success');
        this._showFgConfigModal(gid);
        this.render(this.projectId);
    },

        // 恢复「上一组四宫格」衔接图
    _fgRestorePrevLink(gid) {
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === gid);
        if (!g) return;
        g.prevLinkDisabled = false;
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
        App.showToast('已恢复上一镜衔接（@图0=上一组四宫格）', 'success');
        this._showFgConfigModal(gid);
        this.render(this.projectId);
    },

    // 通用图片选择器（单选，含人物/道具/场景图 + 四宫格/切割分镜），选定后回调 mediaId。
    // 选完会自动回到四宫格配置弹窗（由各回调内 _showFgConfigModal 负责）。
    _fgImagePicker(gid, title, onPick) {
        const all = this._allImageAssets();
        if (!all.length) { App.showToast('暂无可选图像，请先在人物/道具/场景页生成图，或生成四宫格', 'info'); return; }
        this._fgPickerCb = onPick;
        this._fgPickerGid = gid;
        // 复用「按分镜分块 + 每行（四宫格 + 4 张切分）」的统一渲染
        const blocks = this._groupAssetsBySb(all);
        const sections = this._renderPickBlocks(blocks, 'single', null, 'StoryboardModule._fgImagePicked');
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">${title}</h2><button class="modal-close" onclick="StoryboardModule._showFgConfigModal('${gid}')">×</button></div>
            <div class="modal-body sb-pick-body">
                <p class="form-hint">点击任意图像即可选用。分镜图每行：四宫格 + 它的 4 张切分图。</p>
                ${sections}
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="StoryboardModule._showFgConfigModal('${gid}')">返回</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    _fgImagePicked(mid) {
        const cb = this._fgPickerCb;
        this._fgPickerCb = null;
        if (cb) cb(parseInt(mid));
    },

    // 通用：上传一张图写入分镜素材库（ownerType=storyboards），回调返回新 mediaId
    _fgUploadToLib(gid, onDone) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = async e => {
            const f = e.target.files[0]; if (!f) return;
            const r = new FileReader();
            r.onload = async ev => {
                const data = ev.target.result;
                const dims = await CharacterModule.computeDims(data);
                const entry = await Storage._addMedia(this.projectId, 'image', 'storyboards', gid, data, null, dims);
                if (onDone) onDone(entry.id);
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
            const names = missing.map(a => a.prevLink ? `@图${a.idx} 上一组四宫格（上一组尚未生成图）` : `@图${a.idx} ${a.name}`).join('、');
            const hasPrevMiss = missing.some(a => a.prevLink);
            const ok = await App.confirm({
                title: '⚠️ 缺少参考图',
                message: `还有 ${missing.length} 张参考图未就绪：\n${names}\n\n`
                    + (hasPrevMiss ? '其中「上一组四宫格」缺失：请先生成上一组的四宫格（或上一个单分镜），否则本组将失去与上一镜的画面衔接。\n\n' : '')
                    + '确定在缺少参考图的情况下继续生成吗？',
                okText: '仍要生成',
                cancelText: '去补齐',
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

        // 若启用了「上一组四宫格」衔接且该图确实传入（@图0 有图），在提示词最前拼接 @图0 衔接说明：
        //   优先使用用户在 @图0 区域编辑的 prevLinkNote（允许自定义）；
        //   为空时使用默认衔接要求；
        //   用户移除衔接（prevLinkDisabled）时不拼接任何内容（@图0 区域置灰）。
        let basePrompt = g.nanoPrompt || g.globalPrompt || '';
        const prevAsset = assets.find(a => a.prevLink && a.url);
        if (prevAsset && !g.prevLinkDisabled) {
            const userNote = (g.prevLinkNote || '').trim();
            // 默认衔接要求与弹窗展示保持一致：带上一组 local_prompt，说明由下游模型按四宫格要求自行决定是否参考
            const linkNote = userNote || this._buildPrevLinkNote(this._prevGroupLastLocal(g));
            basePrompt = `${linkNote}\n` + basePrompt;
        }

        const submit = await API.post('/api/storyboard/fourgrid', {
            prompt: basePrompt,
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
        const manual = g.refManual || {};   // { "type:name": mediaId } 缺图时用户手动指定的图
        const excluded = new Set(g.refExcluded || []);   // 用户手动移除的素材（type:name），不再出现在清单中
        const push = (type, name) => {
            if (!name) return;
            const key = type + ':' + name;
            if (excluded.has(key)) return;   // 已被移除 → 跳过（out.length 不增，@图索引自动重排）
            if (seen.has(key)) return; seen.add(key);
            const item = findItem(type, name);
            let url = '', mediaId = null, missing = true;
            if (item) {
                const m = Storage.getSelectedMedia(this.projectId, typeToStorage(type), item, 'image');
                if (m) { url = Storage.mediaUrl(m.data); mediaId = m.id; missing = false; }
            }
            // 缺图时若用户手动指定了某张库内图像，则用它补上（含切割分镜/上传图）
            if (missing && manual[key] != null) {
                const mm = Storage.getMediaById(this.projectId, manual[key]);
                if (mm) { url = Storage.mediaUrl(mm.data); mediaId = mm.id; missing = false; }
            }
            out.push({ idx: out.length + 1, type, name, item, mediaId, url, missing, manualKey: key });
        };

        // 追加用户手动添加的额外参考图（不依赖人物/道具/场景库，直接引用任意已生成图像/切割分镜/上传图）
        const pushExtras = () => {
            (g.extraRefIds || []).forEach(mid => {
                const m = Storage.getMediaById(this.projectId, mid);
                if (!m) return;
                out.push({ idx: out.length + 1, type: 'extra', name: '附加参考图', item: null, mediaId: m.id, url: Storage.mediaUrl(m.data), missing: false, extra: true, extraId: mid });
            });
        };

        // 收尾：① 非首组默认把「上一组最后一个分镜图像」作为 @图1 插到最前（用于宫格间衔接）；
        //       ② 统一重排 @图N 索引（unshift 后位置即顺序）；③ 截断至 8 张（编辑接口上限）。
        const finalize = () => {
            // 上一组末帧衔接图：默认开启，用户可在清单里「移除」(g.prevLinkDisabled=true)
            if (!g.single && !g.prevLinkDisabled) {
                const prev = this._prevGroupLastImage(g);
                if (prev) {
                    // prev.url 有图 → 正常衔接；无图 → 缺失占位，渲染时高亮提示
                    out.unshift({
                        idx: 0, type: 'prev', name: '上一组四宫格',
                        item: null, mediaId: prev.mediaId || null, url: prev.url || '',
                        missing: !prev.url, prevLink: true,
                        prevGroupNo: prev.groupNo,
                    });
                }
            }
            // 重排 idx：上一组四宫格固定为 @图0（不占用 @图1 序号），其余参考图从 @图1 开始顺序编号。
            let n = 0;
            out.forEach((a) => { a.idx = a.prevLink ? 0 : (++n); });
            // 截断至 8 张（编辑接口上限）；末帧衔接图始终保留，普通参考图最多 8 张。
            const prevList = out.filter(a => a.prevLink);
            const normalList = out.filter(a => !a.prevLink).slice(0, 8);
            return prevList.concat(normalList);
        };

        // ① 若 CC/Mock 标注了 ref_assets → 按其顺序（额外参考图仍需追加到末尾）
        if (Array.isArray(g.refAssets) && g.refAssets.length) {
            g.refAssets.forEach(r => push(r.type || 'character', r.name));
            pushExtras();
            return finalize();
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

        // ⑤ 用户手动添加的额外参考图（不依赖人物/道具/场景库，直接引用任意已生成图像/切割分镜/上传图）
        pushExtras();

        return finalize();
    },

    // 定位「上一组的四宫格成品图」用于宫格间衔接（按 storyboardGroups 数组顺序取当前组之前最近的一组）：
    //   · 上一组是四宫格 → 取整张四宫格成品图（fourGridImageId）；缺则回退第 4 个 panel 切分图（panelImages[3]）
    //   · 上一组是单分镜 → 取其 imageId
    // 返回 { url, mediaId, groupNo } —— 找不到上一组返回 null；上一组存在但未生成图返回 { url:'' } 以便缺失提示。
    _prevGroupLastImage(g) {
        const p = Storage.getProject(this.projectId);
        const groups = p.storyboardGroups || [];
        const idx = groups.findIndex(x => x.id === g.id);
        if (idx <= 0) return null;   // 首组（idx 0）或未找到 → 无上一组
        const prev = groups[idx - 1];
        const groupNo = idx;   // 上一组的「第几组」(1-based 显示)
        let mediaId = null;
        if (prev.single) {
            mediaId = prev.imageId != null ? prev.imageId : null;
        } else {
            // 优先整张四宫格成品图；缺失才回退第 4 个 panel 切分图
            const panels = prev.panelImages || [];
            mediaId = prev.fourGridImageId != null ? prev.fourGridImageId : (panels[3] != null ? panels[3] : null);
        }
        if (mediaId == null) return { url: '', mediaId: null, groupNo };
        const m = Storage.getMediaById(this.projectId, mediaId);
        return { url: m ? Storage.mediaUrl(m.data) : '', mediaId: m ? m.id : null, groupNo };
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

    // 生成一张纯白 PNG 的 base64（不含 data: 前缀），用于「白场尾段」。
    // 尺寸用通用竖屏 768×1280；后端会按工作流分辨率 resize，纯白图任何比例缩放仍是纯白，不影响。
    _whiteFrameB64() {
        const cv = document.createElement('canvas');
        cv.width = 768; cv.height = 1280;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cv.width, cv.height);
        return (cv.toDataURL('image/png') || '').split(',')[1] || '';
    },

    // 前端 canvas 2x2 等分切四宫格 → 存为 4 张 panel 图
    async _splitFourGrid(g, dataUrl) {
        // 历史重选/删除回退时传入的是「服务器路径URL」，直接画到 canvas 会污染画布导致 toDataURL 抛 SecurityError、
        // 切分静默失败、面板不更新。这里先把图取成同源可用的 dataURL（优先 fetch→blob→base64，失败再退回 crossOrigin 加载）。
        let src = dataUrl;
        if (dataUrl && !dataUrl.startsWith('data:')) {
            try {
                const blob = await (await fetch(dataUrl, { cache: 'no-store' })).blob();
                src = await new Promise((res, rej) => {
                    const fr = new FileReader();
                    fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob);
                });
            } catch (e) { src = dataUrl; }   // 退回原 URL，下面再尝试 crossOrigin
        }
        const img = await new Promise((res, rej) => {
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = () => res(im); im.onerror = rej; im.src = src;
        });
        const hw = Math.floor(img.naturalWidth / 2);
        const hh = Math.floor(img.naturalHeight / 2);
        const positions = [[0, 0], [hw, 0], [0, hh], [hw, hh]]; // 左上 右上 左下 右下
        // 去白边：每个面板四周向内裁切 fgTrim 像素（设置中可改），避免宫格之间的白色分隔线/留白被切进画面
        let trim = parseInt((Storage.getSettings().imageDefaults || {}).fgTrim, 10);
        if (!Number.isFinite(trim) || trim < 0) trim = 0;
        // 安全上限：裁切量不超过半格尺寸的 40%，防止把画面裁没
        trim = Math.min(trim, Math.floor(Math.min(hw, hh) * 0.4));
        const ids = [null, null, null, null];
        for (let i = 0; i < 4; i++) {
            const sx = positions[i][0] + trim;
            const sy = positions[i][1] + trim;
            const sw = Math.max(1, hw - trim * 2);
            const sh = Math.max(1, hh - trim * 2);
            const cv = document.createElement('canvas');
            cv.width = sw; cv.height = sh;
            cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
            const panelData = cv.toDataURL('image/png');
            const entry = await Storage._addMedia(this.projectId, 'image', 'storyboards', g.id + '_panel' + i, panelData, null, { w: sw, h: sh });
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
workflow: (Storage.getSettings().voiceSettings || {}).cloneWorkflow || 'vocpm',
emotions: this._collectEmotions(),
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
                ${this._emotionPanelHtml('sa')}
                ${curUrl ? `<div class="sb-audio-ref"><span class="sb-audio-ref-label">当前配音</span><audio controls preload="none" src="${curUrl}"></audio>${App.audioDragHandle(curUrl, `分镜配音_${gid}_${panelIdx}.${((curAud && curAud.mime) || '').includes('mpeg') ? 'mp3' : ((curAud && curAud.mime) || '').includes('flac') ? 'flac' : 'wav'}`, '拖出')}</div>` : ''}
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
                    ${App.audioDragHandle(Storage.mediaUrl(a.data), `分镜配音_${gid}_${panelIdx}_${idx + 1}.${((a.mime) || '').includes('mpeg') ? 'mp3' : ((a.mime) || '').includes('flac') ? 'flac' : 'wav'}`, '拖出')}
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
workflow: (Storage.getSettings().voiceSettings || {}).cloneWorkflow || 'vocpm',
emotions: this._collectEmotions(),
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
        // 删除该分镜本身；若删除的是四宫格组，连带删除它的内嵌单分镜（inlineParent===gid），避免变成顶层孤儿。
        const groups = (p.storyboardGroups || []).filter(x => x.id !== gid && x.inlineParent !== gid);
        Storage.updateProject(this.projectId, { storyboardGroups: groups });
        App.closeModal();
        App.showToast('已删除', 'success');
        this.render(this.projectId);
    },

    // 全选删除：一键清空当前项目下的所有分镜（四宫格 + 单分镜）
    delAllGroups() {
        const p = Storage.getProject(this.projectId);
        const groups = p.storyboardGroups || [];
        if (!groups.length) return;
        const total = groups.length;
        const single = groups.filter(g => g.single).length;
        const four = total - single;
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `<div class="modal-header"><h2 class="modal-title">确认全部删除</h2></div>
            <div class="modal-body"><p style="text-align:center;padding:1rem">确定要删除当前项目下的<b>全部 ${total} 个分镜</b>（${four} 组四宫格 · ${single} 个单分镜）吗？<br>此操作不可撤销。</p></div>
            <div class="modal-footer"><button class="btn-secondary" onclick="App.closeModal()">取消</button>
            <button class="btn-danger" onclick="StoryboardModule.doDelAllGroups()">确认全部删除</button></div>`;
        document.getElementById('modalOverlay').classList.add('active');
    },

    doDelAllGroups() {
        Storage.updateProject(this.projectId, { storyboardGroups: [] });
        App.closeModal();
        App.showToast('已删除全部分镜', 'success');
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
                if (g.inlineParent) return;              // 内嵌单分镜由其父组循环负责插入，顶层跳过避免重复
                if (g.selected === false) return;        // 未勾选合成 → 不纳入
                // 扩展四宫格的单分镜：拆成 4 段连续（占原时长平分），逐格用 panelImages（提示语统一用分镜 local）
                if (g.expanded && Array.isArray(g.panelImages) && g.panelImages.some(x => x != null)) {
                    const panels = g.panelImages || [];
                    if (panels.every(x => x == null)) { skipNoImg++; return; }
                    if (!firstMeta) firstMeta = g;
                    for (let i = 0; i < 4; i++) {
                        const imgId = panels[i];
                        if (imgId == null) continue;       // 缺某格则跳过该格（其余格仍连续）
                        segments.push({
                            uid: Storage._uid(),
                            groupId: g.id, panel: i, single: true, expanded: true,
                            imageId: imgId,
                            // 台词只放第 1 格，避免 4 段重复同一句配音
                            audioId: i === 0 ? g.audioId : null,
                            prompt: g.prompt || '',
                            length: 90, trimStart: 0,
                            transition: g.transition || 'cut',
                            shotTransition: (g.shotTransitions || [])[i] || '',
                            dialogue: i === 0 ? (g.dialogue || {}) : {},
                        });
                    }
                    return;
                }
                if (g.imageId == null) { skipNoImg++; return; }   // 勾选了但没生成图 → 跳过并计数
                if (!firstMeta) firstMeta = g;
                segments.push({
                    uid: Storage._uid(),
                    groupId: g.id, panel: 0, single: true,
                    imageId: g.imageId, audioId: g.audioId,
                    prompt: g.prompt || '',
                    length: 90, trimStart: 0,
                    transition: g.transition || 'cut',
                    shotTransition: (g.shotTransitions || [])[0] || '',
                    dialogue: g.dialogue || {},
                });
                return;
            }
            // 四宫格：逐面板，按 panel 勾选纳入；勾选但无切分图 → 跳过并计数。
            // 每格使用「该格自己的 local 提示词」g.localPrompts[i]（不再共用全局 globalPrompt，
            // 否则会出现「每个分镜 local 都一样」的问题）。
            // 配音/台词按格各自挂载：哪一格生成了 panelAudios[i] 就挂它自己的音频与该格台词
            //（支持「四格分别配音」）；某格没单独配音时，回退用本组第一段的音频/台词兜底，
            // 避免「四格都生成了音频，合成却只有第一格有声」的问题。
            const dlg = g.dialogues || [];
            const auds = g.panelAudios || [];
            const localPrompts = Array.isArray(g.localPrompts) ? g.localPrompts : [];
            // 本组是否「按格分别配音」：有任意非首格也生成了音频，则视为逐格配音模式
            const perPanelAudio = auds.filter(Boolean).length > 1
                || auds.slice(1).some(Boolean);
            let groupFirstDone = false;   // 本组是否已放置过「带台词的第一段」
            for (let i = 0; i < 4; i++) {
                if (g.panelSelected && g.panelSelected[i] === false) continue;  // 未勾选
                const imgId = (g.panelImages || [])[i];
                if (imgId == null) { skipNoImg++; continue; }                   // 勾选但无图
                if (!firstMeta) firstMeta = g;
                const isGroupFirst = !groupFirstDone;   // 本组第一段（物理 panel 不一定是 0，按实际纳入顺序）
                groupFirstDone = true;
                // 逐格配音模式：每格挂各自的音频 + 各自台词；
                // 单句配音模式（仅第一格有音频）：保持老行为，只第一段带，避免同一句被读 4 遍。
                const useOwn = perPanelAudio;
                segments.push({
                    uid: Storage._uid(),
                    groupId: g.id, panel: i,
                    imageId: imgId,
                    audioId: useOwn ? (auds[i] || null) : (isGroupFirst ? auds[i] : null),
                    prompt: (localPrompts[i] || '').trim(),   // 该格自己的 local 提示词
                    length: 90, trimStart: 0,
                    transition: g.transition || 'cut',
                    shotTransition: (g.shotTransitions || [])[i] || '',
                    dialogue: useOwn ? (dlg[i] || {}) : (isGroupFirst ? (dlg[i] || {}) : {}),
                });
                // 该格之后的内嵌单分镜：按普通单分镜规则纳入（勾选 & 有图）
                for (const sg of all.filter(x => x.single && x.inlineParent === g.id && (parseInt(x.inlinePanel, 10) || 0) === i)) {
                    if (sg.selected === false) continue;
                    if (sg.imageId == null) { skipNoImg++; continue; }
                    if (!firstMeta) firstMeta = sg;
                    segments.push({
                        uid: Storage._uid(),
                        groupId: sg.id, panel: 0, single: true,
                        imageId: sg.imageId, audioId: sg.audioId,
                        prompt: sg.prompt || '',
                        length: 90, trimStart: 0,
                        transition: sg.transition || 'cut',
                        shotTransition: (sg.shotTransitions || [])[0] || '',
                        dialogue: sg.dialogue || {},
                    });
                }
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
        const TRANS_DEF_SEC = 0.5;  // 转场默认时长（秒）：默认 0.5s，少占总时长，仍可在预览区手动调大
        segments.forEach(s => {
            const len = s.length || DEF;
            const imgUid = Storage._uid();
            // 转场「附着」在图像段上：shotTransition 文本 + 默认 1s 时长。
            // 不再作为时间轴独立块；合成时由后端自动插在两段之间并顺延音频（不用手动摆位置）。
            const tText = (s.shotTransition || '').trim();
            imageClips.push({
                uid: imgUid,
                imageId: s.imageId, prompt: s.prompt || '',
                // 回写映射：记住该段来自哪个分镜组的哪个面板，用于在时间轴里编辑 local/转场提示词时同步回原始分镜
                groupId: s.groupId, panel: s.panel, single: !!s.single,
                dialogue: s.dialogue || {}, transition: s.transition || 'cut',
                shotTransition: tText,                                 // 该段后的转场描述文本
                transitionDur: tText ? TRANS_DEF_SEC : 0,              // 转场时长（秒），无文本=0=不插入
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

        // 注：结尾乱码/花屏已在后端用「总帧数对齐到 8k+1 + 末段延伸」根治（见 backend.py），
        // 不再需要前端追加白场/定格尾段。

        // 参与合成的分镜组号范围（用于视频历史命名「分镜X-Y」）：取 segments 涉及组在 all 中的序号
        const involvedIdx = [];
        segments.forEach(s => {
            const gi = all.findIndex(x => x.id === s.groupId);
            if (gi >= 0 && !involvedIdx.includes(gi)) involvedIdx.push(gi);
        });
        involvedIdx.sort((a, b) => a - b);
        const groupFrom = involvedIdx.length ? involvedIdx[0] + 1 : 1;
        const groupTo = involvedIdx.length ? involvedIdx[involvedIdx.length - 1] + 1 : 1;

        this._tl = {
            imageClips, audioClips,
            totalFrames: cursor,                 // 视频总长（可调）；超出部分置灰
            groupFrom, groupTo,                  // 视频历史命名用：参与合成的分镜组号范围
            fps: this.FPS,
            pxPerFrame: 1.4,                      // 缩放：像素/帧
            globalPrompt: '',                     // 全局提示词默认发空给 comfyui 导演台（由各段 local 提示词驱动；不再用某段提示词冒充全局）
            guideStrength: '1.00',                // 引导强度默认值（1.0=最大约束，最贴近引导图）
                // Epsilon / 合成工作流：默认值取自设置（settings.videoDefaults），可在时间轴弹窗内临时改动
                epsilon: (Storage.getSettings().videoDefaults || {}).epsilon ?? 0.9,
                workflow: (Storage.getSettings().videoDefaults || {}).workflow || 'director',
                // 生成视频分辨率（格式「宽 x 高 (比例)」），默认取设置，后端按工作流注入
                resolution: (Storage.getSettings().videoDefaults || {}).resolution || '1280 x 720 (16:9)',
                // 使用音频：ON=用上传音频；OFF=让模型按提示词从零生成音频（含环境音）。
                // 两个工作流（乱神版/旧导演台）均默认关闭（由模型从零生成音频）。
                useCustomAudio: false,
            selectedUid: (imageClips[0] && imageClips[0].uid) || null,  // 预览/编辑当前选中的图像段
            playFrame: 0, playing: false,
        };
        this._renderTimeline();
        this._loadAudioDurations(true);          // 异步回填音频时长，并按时长对齐图音、统一序号
    },

    // 读取各音频块真实时长（秒→帧）。除了用于裁剪上限，还在「初始化对齐」时
    // 把音频块 length 设为真实时长，并让其关联的图像段对齐到同样时长（s 数一致），
    // 然后整体重新紧贴布局、音频跟随对应图像段的 start —— 实现「图音对齐、序号一致」。
    // 读取设置中「图像比音频多出的时长」（秒）→ 帧。前/后可分别设置（默认各 0.5s）。
    // 用于时间轴音频/图像对齐：图像段 = 音频 + 前留白 + 后留白，音频在段内后移「前留白」帧。
    _audioPadFrames() {
        const tl = this._tl;
        const fps = (tl && tl.fps) || this.FPS || 24;
        const defs = (Storage.getSettings().imageDefaults) || {};
        const head = Number.isFinite(+defs.audioPadHeadSec) ? Math.max(0, +defs.audioPadHeadSec) : 0.5;
        const tail = Number.isFinite(+defs.audioPadTailSec) ? Math.max(0, +defs.audioPadTailSec) : 0.5;
        return { head: Math.round(head * fps), tail: Math.round(tail * fps) };
    },

    async _loadAudioDurations(alignInit) {
        const tl = this._tl; if (!tl) return;
        // 有音频的图像段：在音频时长基础上前/后各留一段画面（时长在设置中可调，以秒为单位）。
        const { head: PAD_HEAD, tail: PAD_TAIL } = this._audioPadFrames();
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
                    // 关联图像段时长 = 音频时长 + 前留白 + 后留白（让画面在语音前/后各多留一段，秒数可在设置中调）
                    const img = a.imgUid ? tl.imageClips.find(c => c.uid === a.imgUid) : null;
                    if (img) img.length = a.audioDurationFrames + PAD_HEAD + PAD_TAIL;
                }
            } catch (e) { /* 忽略 */ }
        }
        if (alignInit) {
            // 图像轨重新紧贴布局；音频在所属图像段内后移 1 秒（前留 1s 画面，尾部自然剩 1s）；总长 = 末段结束
            this._relayoutImages();
            tl.audioClips.forEach(a => {
                const img = a.imgUid ? tl.imageClips.find(c => c.uid === a.imgUid) : null;
                if (img) {
                    // 仅当图像段确实比音频长（即已加过 padding）时，音频才后移「前留白」帧；否则与段首对齐
                    const pad = (img.length > a.length) ? PAD_HEAD : 0;
                    a.start = img.start + pad;
                }
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
                    <label class="sb-dir-total sb-dir-selwrap">帧率
                        <span class="sb-dir-select">
                            <select id="tlFps" onchange="StoryboardModule.tlSetFps(this.value)">
                                <option value="24" ${tl.fps === 24 ? 'selected' : ''}>24 fps</option>
                                <option value="30" ${tl.fps === 30 ? 'selected' : ''}>30 fps</option>
                            </select>
                        </span>
                    </label>
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
                    <span class="sb-dir-guide">引导强度
                        <input type="number" id="tlGuide" min="0" max="1" step="0.05" value="${tl.guideStrength || '1.00'}"
                            oninput="StoryboardModule.tlSetGuide(this.value)">
                    </span>
                    <span class="sb-dir-guide">
                        Epsilon
                        <input type="number" id="tlEpsilon" min="0.001" max="1" step="0.001" value="${(tl.epsilon ?? 0.9)}"
                            oninput="StoryboardModule.tlSetEpsilon(this.value)">
                    </span>
                    <span class="sb-dir-guide" title="使用音频：开启=使用你上传/添加的音频；关闭=不使用上传音频，由模型根据提示词从零生成整段音频（可含环境音/氛围，但人声质量较低）">
                        <label class="sb-dir-switch">
                            <input type="checkbox" id="tlUseAudio" ${tl.useCustomAudio ? 'checked' : ''}
                                onchange="StoryboardModule.tlSetUseAudio(this.checked)">
                            使用音频
                        </label>
                    </span>
                    <span class="sb-dir-sep"></span>
                    <span class="sb-dir-guide sb-dir-selwrap">合成工作流
                        <span class="sb-dir-select">
<select id="tlWorkflow" onchange="StoryboardModule.tlSetWorkflow(this.value)">
<option value="director" ${(tl.workflow || 'director') === 'director' ? 'selected' : ''}>旧导演台 LTXDirector</option>
<option value="singularity" ${tl.workflow === 'singularity' ? 'selected' : ''}>Singularity 乱神版V3</option>
<option value="yusu" ${tl.workflow === 'yusu' ? 'selected' : ''}>Yusu 导演台</option>
</select>
                        </span>
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
                <div id="tlVideoErrBanner">${this._videoErrBannerHtml()}</div>
                <div class="sb-dir-preview" id="tlPreview"></div>
                <audio id="tlAudioEl" preload="auto" style="display:none"></audio>
                <div id="tlVideoResult"></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="StoryboardModule.closeTimeline()">关闭</button>
                <button class="btn-danger" id="tlCancelBtn" style="display:none" onclick="StoryboardModule.cancelVideo()">⏹ 打断</button>
                <button class="btn-primary" id="tlGenBtn" onclick="StoryboardModule.confirmGenVideo()">🎬 生成视频</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
        this._renderTracks();
        this._updatePreview();
        this._resumeVideoTask();   // 若有进行中的视频任务：恢复计时/轮询/按钮态
    },

    // ===== 视频生成：任务持久化（关弹窗/刷新仍保持）=====
    _saveVideoTask(t) { try { localStorage.setItem(this._VIDEO_TASK_KEY, JSON.stringify(t)); } catch (e) {} },
    _loadVideoTask() { try { return JSON.parse(localStorage.getItem(this._VIDEO_TASK_KEY) || 'null'); } catch (e) { return null; } },
    _clearVideoTask() { try { localStorage.removeItem(this._VIDEO_TASK_KEY); } catch (e) {} },

    // ===== 视频生成：顶部失败横幅（可×，下次生成清除）=====
    _saveVideoErr(text) { try { localStorage.setItem(this._VIDEO_ERR_KEY, JSON.stringify({ text, ts: Date.now() })); } catch (e) {} },
    _loadVideoErr() { try { return JSON.parse(localStorage.getItem(this._VIDEO_ERR_KEY) || 'null'); } catch (e) { return null; } },
    _clearVideoErr() {
        try { localStorage.removeItem(this._VIDEO_ERR_KEY); } catch (e) {}
        const el = document.getElementById('tlVideoErrBanner');
        if (el) el.innerHTML = '';
    },
    dismissVideoErr() { this._clearVideoErr(); },
    _videoErrBannerHtml() {
        const r = this._loadVideoErr();
        if (!r || !r.text) return '';
        return `<div class="gen-result-banner err" id="sbVideoErrBanner">
            <span class="gen-result-icon">❌</span>
            <span class="gen-result-text">${this.esc(r.text)}</span>
            <button class="gen-result-close" title="关闭" onclick="StoryboardModule.dismissVideoErr()">×</button>
        </div>`;
    },
    _renderVideoErrBanner() {
        const host = document.getElementById('tlVideoErrBanner');
        if (host) host.innerHTML = this._videoErrBannerHtml();
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
        // 播放头（红线）可左右拖动
        const ph = host.querySelector('.sb-dir-playhead');
        if (ph) this._bindPlayheadDrag(ph);
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
            const isWhite = !!c.whiteFrame;
            return `<div class="sb-dir-clip sb-dir-img ${overflow ? 'sb-dir-of' : ''} ${selected ? 'sb-dir-sel' : ''} ${isWhite ? 'sb-dir-white' : ''}" data-kind="img" data-uid="${c.uid}" data-i="${i}"
                style="left:${left}px;width:${width}px;${isWhite ? 'background:#fff' : (url ? `background-image:url('${url}')` : '')}">
                ${overflow ? '<div class="sb-dir-of-badge" title="超出视频总长，不会被合成">超出</div>' : ''}
                <div class="sb-dir-handle l" data-h="l" title="拖动改时长（后续图片跟随移动）"></div>
                <div class="sb-dir-clip-body" title="点击：在下方编辑提示词 / 拖动换位 / 拉两侧改时长">
                    ${(url || isWhite) ? '' : '<span class="sb-dir-noimg">无图</span>'}
                    <span class="sb-dir-clip-meta">${c.isTail ? '⬜ 白场' : '#' + (i + 1)} · ${secsLabel}</span>
                    ${c.isTail ? '<span class="sb-dir-clip-prompt" title="自动追加的白场尾段：纯白画面，时长=最后一个分镜。用于把 LTX 结尾漂移隔开、便于剪辑裁掉；不需要可点 × 删除" style="color:#888">白场尾段·可删</span>' : (promptText ? `<span class="sb-dir-clip-prompt" title="${promptText}">${promptText}</span>` : '')}
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
                    // ===== 音频移位：拖动中自由跟随鼠标（允许暂时重叠），松手时才避让不重叠 =====
                    const want = Math.max(0, orig.start + dFrames);
                    clip.start = want;                  // 跟手，不做避让
                    self._renderTracks();
                    const cur = document.querySelector(`.sb-dir-clip[data-kind="aud"][data-uid="${uid}"]`);
                    if (cur) cur.classList.add('sb-dir-aud-dragging');
                    // 落点与相邻音频边缘对齐 → 显示竖向辅助线
                    self._showAudioAlignLine(clip);
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
                self._clearAudioAlignLine();
                if (isImgReorder && moved && dropTarget != null) {
                    // 图像：松手才真正落位 → 移到目标索引 → relayout → 重绘（带平滑过渡）
                    const from = arr.findIndex(c => c.uid === uid);
                    const moving = arr[from];
                    arr.splice(from, 1);
                    arr.splice(dropTarget, 0, moving);
                    self._relayoutImages();
                    self._tl._animateNext = true;
                } else if (isBodyDrag && kind === 'aud' && moved) {
                    // 音频：拖动中允许自由重叠跟手；松手这一刻才做避让，
                    // 按拖动落点把自己错开到不与其它音频段重叠的位置，再按 start 重排。
                    // 用拖动起点 orig.start 作为方向参考，决定碰撞时贴向左侧还是右侧。
                    clip.start = self._snapAudioAvoid(clip, clip.start, orig.start);
                    self._reorderAudioByStart(uid);
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

    // 拖动音频时：若该块的左/右边缘正好贴合相邻音频边缘或图像段边界，显示一条竖向对齐线
    _showAudioAlignLine(clip) {
        const host = document.getElementById('sbDirTracks');
        if (!host) return;
        const tl = this._tl;
        const ppf = tl.pxPerFrame;
        const TOL = 1;   // 已经吸附贴合，容差取 1 帧
        // 收集所有可对齐的边界帧：其它音频段两端 + 图像段两端
        const edges = [];
        tl.audioClips.forEach(c => { if (c.uid !== clip.uid) { edges.push(c.start); edges.push(c.start + c.length); } });
        tl.imageClips.forEach(c => { edges.push(c.start); edges.push(c.start + c.length); });
        const myL = clip.start, myR = clip.start + clip.length;
        let hit = null;
        for (const ef of edges) {
            if (Math.abs(myL - ef) <= TOL || Math.abs(myR - ef) <= TOL) { hit = ef; break; }
        }
        if (hit == null) { this._clearAudioAlignLine(); return; }
        let line = host.querySelector('.sb-dir-align-line');
        if (!line) {
            line = document.createElement('div');
            line.className = 'sb-dir-align-line';
            host.appendChild(line);
        }
        line.style.cssText = `left:${Math.round(hit * ppf)}px`;
    },
    _clearAudioAlignLine() {
        const host = document.getElementById('sbDirTracks');
        const line = host && host.querySelector('.sb-dir-align-line');
        if (line) line.remove();
    },

    // 音频：按各段当前 start 排序数组顺序（保持视觉顺序与数组一致，便于换位语义）
    _reorderAudioByStart(uid) {
        this._tl.audioClips.sort((a, b) => a.start - b.start);
    },

    // 快速拖动时的磁吸避让：把目标 start 夹到不与其它音频段重叠的位置。
    // 按拖动方向把自己贴到碰撞段的外侧边界（碰到别的段就停下，不穿过）。慢速拖动不调用此方法（允许重叠）。
    _snapAudioAvoid(clip, ns, fromStart) {
        const len = clip.length;
        const others = this._tl.audioClips.filter(c => c.uid !== clip.uid);
        if (!others.length) return Math.max(0, ns);
        // 方向参考：松手避让时传 fromStart（拖动起点）；否则用当前 start
        const ref = (fromStart == null) ? clip.start : fromStart;
        const movingRight = ns >= ref;           // 拖动方向
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
    tlSetGuide(v) {
        let n = parseFloat(v);
        if (isNaN(n)) n = 0.7;
        n = Math.max(0, Math.min(1, n));   // 引导强度上限 0~1
        this._tl.guideStrength = n.toFixed(2);
    },
tlSetUseAudio(checked) {
this._tl.useCustomAudio = !!checked;
this._tl._audioUserSet = true;   // 标记用户手动设置过：之后切换工作流不再自动覆盖
},
  tlSetWorkflow(v) {
// 导演台工作流选择：'director'(默认) | 'singularity' | 'yusu'
const tl = this._tl;
tl.workflow = (v === 'singularity' || v === 'yusu') ? v : 'director';
            // 「使用音频」两个工作流均默认关闭；仅当用户未手动改过该开关时才同步默认值，避免覆盖用户的显式选择。
            if (!tl._audioUserSet) {
                tl.useCustomAudio = false;
                const cb = document.getElementById('tlUseAudio');
                if (cb) cb.checked = tl.useCustomAudio;
            }
},
    tlSetFps(v) {
        // 切换帧率：按比例重算所有段的帧数，保持镜头「秒数」不变。
        // 降到 24fps → 同样秒数的镜头帧数变少 → 总帧数变少 → 二阶段(上采样精修)显存与耗时显著下降。
        const tl = this._tl; if (!tl) return;
        const next = (parseInt(v) === 24) ? 24 : 30;
        const old = tl.fps || 30;
        if (next === old) return;
        const r = next / old;   // 缩放因子（如 24/30 = 0.8）
        const conv = n => Math.max(1, Math.round((Number(n) || 0) * r));
        (tl.imageClips || []).forEach(c => {
            c.start = Math.round((c.start || 0) * r);
            c.length = conv(c.length);
            // transitionDur 是「秒」，与帧率无关，保持不变
        });
        (tl.audioClips || []).forEach(a => {
            a.start = Math.round((a.start || 0) * r);
            a.length = conv(a.length);
            a.trimStart = Math.round((a.trimStart || 0) * r);
            // 音频真实时长按新帧率换算（帧数 = 秒 × fps）
            if (a.audioDurationFrames) a.audioDurationFrames = conv(a.audioDurationFrames);
        });
        tl.totalFrames = Math.max(1, Math.round((tl.totalFrames || 0) * r));
        if (tl.playFrame) tl.playFrame = Math.round(tl.playFrame * r);
        tl.fps = next;
        this._renderTracks();
        this._updatePreview && this._updatePreview();
        // 同步刷新「视频总长」输入框显示
        const totalEl = document.getElementById('tlTotalSec');
        if (totalEl) totalEl.value = (tl.totalFrames / tl.fps).toFixed(1);
    },
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
        const px = Math.round(tl.playFrame * tl.pxPerFrame);
        const ph = document.getElementById('tlPlayhead');
        if (ph) ph.style.left = px + 'px';
        const seek = document.getElementById('tlSeek');
        if (seek && +seek.value !== tl.playFrame) seek.value = tl.playFrame;
        const cur = document.getElementById('tlCur');
        if (cur) cur.textContent = (tl.playFrame / tl.fps).toFixed(2) + 's';
        this._ensurePlayheadVisible(px);   // 红线超出可视区 → 滚动画面跟随
        // 播放中：仅换画面（不重建提示词输入框）；手动定位/暂停：完整刷新
        if (tl.playing) this._updateStage(); else this._updatePreview();
        this._syncAudioToFrame();
    },

    // 让播放头（位于 px 处）始终落在轨道滚动容器的可见范围内：
    // 超出右边界 → 向右滚动；超出左边界 → 向左滚动，并各留一段边距。
    _ensurePlayheadVisible(px) {
        const scroll = document.querySelector('.sb-dir-scroll');
        if (!scroll) return;
        const view = scroll.clientWidth;
        const margin = Math.min(80, view * 0.15);   // 可视区两侧的安全边距
        const left = scroll.scrollLeft;
        const right = left + view;
        if (px > right - margin) {
            scroll.scrollLeft = Math.max(0, px - view + margin);
        } else if (px < left + margin) {
            scroll.scrollLeft = Math.max(0, px - margin);
        }
    },

    // 播放头（红线）拖拽：按鼠标 x 映射到帧并 seek（进度条随之联动、画面自动滚动跟随）。
    // 拖动期间若指针靠近滚动容器左右边缘，自动持续滚动，便于拖到很长的时间轴远处。
    _bindPlayheadDrag(ph) {
        const self = this;
        const onDown = (e) => {
            e.preventDefault(); e.stopPropagation();
            const tracks = document.getElementById('sbDirTracks');
            const scroll = document.querySelector('.sb-dir-scroll');
            if (!tracks) return;
            // 拖动时若正在播放，先暂停，避免帧推进与手动拖动打架
            if (self._tl && self._tl.playing) self.tlTogglePlay();
            ph.classList.add('sb-dir-ph-drag');
            document.body.classList.add('sb-dir-ph-cursor');
            let edgeTimer = null;
            const seekAt = (clientX) => {
                const rect = tracks.getBoundingClientRect();
                const ppf = self._tl.pxPerFrame;
                self.tlSeekFrame(Math.round((clientX - rect.left) / ppf));
            };
            const onMove = (ev) => {
                seekAt(ev.clientX);
                // 指针接近滚动容器边缘 → 持续滚动（拖到远处也能跟）
                if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; }
                if (scroll) {
                    const r = scroll.getBoundingClientRect();
                    const EDGE = 36;
                    let dir = 0;
                    if (ev.clientX > r.right - EDGE) dir = 1;
                    else if (ev.clientX < r.left + EDGE) dir = -1;
                    if (dir) {
                        const lastX = ev.clientX;
                        edgeTimer = setInterval(() => {
                            scroll.scrollLeft = Math.max(0, scroll.scrollLeft + dir * 24);
                            seekAt(lastX);
                        }, 30);
                    }
                }
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (edgeTimer) clearInterval(edgeTimer);
                ph.classList.remove('sb-dir-ph-drag');
                document.body.classList.remove('sb-dir-ph-cursor');
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
        ph.addEventListener('mousedown', onDown);
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
    // ===== 时间轴：分镜段「多张引导图（关键帧）」=====
    // 每个图像 clip 可挂多张引导图：clip.guideImageIds=[mediaId,…]（首张默认=clip.imageId）；
    // clip.guideDurs=[帧,…] 每张占多少帧（可微调，缺省/为 0 则按剩余平分）。
    // 合成时（genVideo）若 >1 张，会把本段按 guideDurs 拆成多个连续子段，逐张发给导演台做关键帧过渡。

    // 取本段引导图 id 列表（规整：去空、首张兜底用 imageId）
    _clipGuideIds(c) {
        if (!c) return [];
        let ids = Array.isArray(c.guideImageIds) ? c.guideImageIds.filter(x => x != null) : [];
        if (!ids.length && c.imageId != null) ids = [c.imageId];
        return ids;
    },
    // 把本段总时长 total 帧按 guideDurs 分配给 n 张图：
    // 已填的（>0）原样保留，未填/为 0 的把「剩余帧」平分；最后做一次收敛保证总和=total（>=n）。
    _clipGuideDurs(c, n, total) {
        total = Math.max(n, Math.round(total || 0));
        const raw = (Array.isArray(c.guideDurs) ? c.guideDurs : []).slice(0, n);
        while (raw.length < n) raw.push(0);
        const fixed = raw.map(v => Math.max(0, Math.round(Number(v) || 0)));
        const usedFixed = fixed.reduce((a, b) => a + b, 0);
        const blanks = fixed.filter(v => v <= 0).length;
        let rest = Math.max(0, total - usedFixed);
        const out = fixed.map(v => v > 0 ? v : 0);
        if (blanks > 0) {
            const each = Math.max(1, Math.floor(rest / blanks));
            let bi = 0;
            for (let i = 0; i < n; i++) {
                if (out[i] > 0) continue;
                bi++;
                out[i] = (bi === blanks) ? Math.max(1, rest - each * (blanks - 1)) : each;
            }
        }
        // 收敛：保证每段 >=1 且总和 == total
        for (let i = 0; i < n; i++) if (out[i] < 1) out[i] = 1;
        let diff = total - out.reduce((a, b) => a + b, 0);
        // 多了/少了都加减到最后一段（保证最少 1 帧）
        out[n - 1] = Math.max(1, out[n - 1] + diff);
        return out;
    },

    // 当前选中段：从全部图像资产里多选「引导图」（人物/道具/场景/分镜），写入 clip.guideImageIds
    tlPickGuideImages() {
        const tl = this._tl;
        const c = tl && (tl.imageClips.find(x => x.uid === tl.selectedUid) || tl.imageClips[0]);
        if (!c) { App.showToast('请先点选一个图像段', 'info'); return; }
        if (c.whiteFrame) { App.showToast('白场段不支持引导图', 'info'); return; }
        const all = this._allImageAssets();
        if (!all.length) { App.showToast('暂无可选图像', 'info'); return; }
        const chosen = new Set(this._clipGuideIds(c).map(String));
        const blocks = this._groupAssetsBySb(all);
        const sections = this._renderPickBlocks(blocks, 'multi', chosen);
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
            <div class="modal-header"><h2 class="modal-title">📎 选择本段引导图（可多选，按勾选顺序作为关键帧）</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
            <div class="modal-body sb-pick-body">
                <p class="form-hint">勾选多张图作为这一段的连续关键帧：合成时本段时长会按顺序分配给每张图，依次过渡（图1→图2→…）。每张图占多长可在面板里微调。</p>
                ${sections}
            </div>
            <div class="modal-footer">
                <span class="rp-sel-count" id="pickSelCount" style="margin-right:auto;font-size:0.8rem;color:var(--t2)">已选 0 张</span>
                <button class="btn-secondary" onclick="App.closeModal()">取消</button>
                <button class="btn-primary" onclick="StoryboardModule._saveGuideImages('${c.uid}')">确定</button>
            </div>`;
        document.getElementById('modalOverlay').classList.add('active');
        this._updatePickCount();   // 初始化计数（含已勾选的）
    },
    // 刷新多选弹窗右下角「已选 N 张」计数（统计当前所有勾选的 checkbox）
    _updatePickCount() {
        const checks = document.querySelectorAll('#modalContent .sb-pick-cell input[type=checkbox]:checked');
        const el = document.getElementById('pickSelCount');
        if (el) el.textContent = `已选 ${checks.length} 张`;
    },
    _saveGuideImages(uid) {
        const checks = document.querySelectorAll('#modalContent .sb-pick-cell input[type=checkbox]:checked');
        const ids = Array.from(checks).map(c => parseInt(c.value)).filter(v => !isNaN(v));
        const c = this._tl && this._tl.imageClips.find(x => x.uid === uid);
        if (c) {
            c.guideImageIds = ids;
            // 第一张同步为 clip 主图（时间轴块、预览展示用）
            if (ids.length) c.imageId = ids[0];
            // 时长数组按新数量裁剪/补 0（0=平分）
            const dur = Array.isArray(c.guideDurs) ? c.guideDurs.slice(0, ids.length) : [];
            while (dur.length < ids.length) dur.push(0);
            c.guideDurs = dur;
        }
        App.closeModal();
        App.showToast(ids.length > 1 ? `本段已设 ${ids.length} 张引导图（关键帧）` : '本段引导图已更新', 'success');
        this._renderTracks();
        this._updatePreview();
    },
    // 移除本段第 k 张引导图
    tlRemoveGuide(uid, k) {
        const c = this._tl && this._tl.imageClips.find(x => x.uid === uid);
        if (!c) return;
        const ids = this._clipGuideIds(c).slice();
        ids.splice(k, 1);
        c.guideImageIds = ids;
        if (Array.isArray(c.guideDurs)) c.guideDurs.splice(k, 1);
        if (ids.length) c.imageId = ids[0]; else c.imageId = null;
        this._renderTracks();
        this._updatePreview();
    },
    // 调整本段第 k 张引导图的时长（秒 → 帧）
    tlSetGuideDur(uid, k, secVal) {
        const c = this._tl && this._tl.imageClips.find(x => x.uid === uid);
        if (!c) return;
        const n = this._clipGuideIds(c).length;
        if (!Array.isArray(c.guideDurs)) c.guideDurs = [];
        while (c.guideDurs.length < n) c.guideDurs.push(0);
        const sec = Math.max(0, Number(secVal) || 0);
        c.guideDurs[k] = Math.round(sec * (this._tl.fps || 30));   // 0=平分剩余
    },

    // 当前段编辑面板里的「本段引导图（多图关键帧）」区：缩略图列表 + 每图时长微调 + 添加/删除
    _guideEditorHtml(c) {
        if (!c || c.whiteFrame) return '';
        const fps = this._tl.fps || 30;
        const ids = this._clipGuideIds(c);
        const n = ids.length;
        // 多图时按本段总长算出每张的实际帧（含平分），用于占位提示
        const total = Math.max(n, Math.round(c.length || 0));
        const durs = n > 1 ? this._clipGuideDurs(c, n, total) : [];
        const thumbs = ids.map((id, k) => {
            const m = Storage.getMediaById(this.projectId, id);
            const url = m ? Storage.mediaUrl(m.data) : '';
            // 输入框：用户填过(>0)就显示，没填就 placeholder 显示自动平分的秒数
            const rawFrames = (c.guideDurs && c.guideDurs[k] > 0) ? c.guideDurs[k] : 0;
            const valAttr = rawFrames > 0 ? `value="${(rawFrames / fps).toFixed(1)}"` : '';
            const ph = n > 1 ? (durs[k] / fps).toFixed(1) : (total / fps).toFixed(1);
            return `<div class="sb-guide-item" title="${m ? this.esc(m.name || '') : '图像已不存在'}">
                <span class="sb-guide-idx">${k + 1}</span>
                ${url ? `<img src="${url}" loading="lazy" title="点击放大查看（可左右切换）" onclick="StoryboardModule.openGuideZoom('${c.uid}',${k})">` : '<div class="sb-guide-noimg">缺图</div>'}
                <button class="sb-guide-del" title="移除这张" onclick="StoryboardModule.tlRemoveGuide('${c.uid}',${k})">×</button>
                <label class="sb-guide-dur" title="这张占多少秒（留空=自动平分剩余时长）">
                    <input type="number" min="0" step="0.1" ${valAttr} placeholder="${ph}"
                        oninput="StoryboardModule.tlSetGuideDur('${c.uid}',${k},this.value)">s
                </label>
            </div>`;
        }).join('');
        const hint = n > 1
            ? `本段 ${n} 张关键帧：合成时按顺序 图1→…→图${n} 依次过渡，单张留空时长则平分剩余。`
            : '本段当前 1 张图。可「＋ 添加引导图」做多张关键帧过渡（图1→图2→…）。';
        return `
            <div class="sb-guide-box">
                <div class="sb-guide-head">
                    <span class="sb-guide-title">📎 本段引导图（多图关键帧）${n ? `<span class="sb-guide-count">共 ${n} 张</span>` : ''}</span>
                    <button class="btn-secondary btn-tiny" onclick="StoryboardModule.tlPickGuideImages()">＋ 添加 / 管理引导图</button>
                </div>
                <div class="sb-guide-list">${thumbs || '<span class="sb-guide-empty">本段暂无引导图</span>'}</div>
                <div class="sb-guide-hint">${hint}</div>
            </div>`;
    },

    // 引导图大图查看器：左右切换看本段选了哪些图（复用四宫格 viewer 样式）。
    openGuideZoom(uid, k) {
        const c = this._tl && this._tl.imageClips.find(x => x.uid === uid);
        if (!c) return;
        const ids = this._clipGuideIds(c);
        const n = ids.length;
        if (!n) { App.showToast('本段暂无引导图', 'info'); return; }
        k = ((parseInt(k, 10) || 0) % n + n) % n;
        const fps = this._tl.fps || 30;
        const durs = n > 1 ? this._clipGuideDurs(c, n, Math.max(n, Math.round(c.length || 0))) : [Math.round(c.length || 0)];
        const m = Storage.getMediaById(this.projectId, ids[k]);
        const url = m ? Storage.mediaUrl(m.data) : '';
        const name = m ? this.esc(m.name || '') : '图像已不存在';
        const dots = ids.map((_, i) =>
            `<span class="sb-quad-dot ${i === k ? 'on' : ''}" title="第${i + 1}张" onclick="StoryboardModule.openGuideZoom('${uid}',${i})"></span>`).join('');
        const navPrev = n > 1 ? `<button class="sb-quad-nav prev" title="上一张" onclick="StoryboardModule.openGuideZoom('${uid}',${k - 1})">‹</button>` : '';
        const navNext = n > 1 ? `<button class="sb-quad-nav next" title="下一张" onclick="StoryboardModule.openGuideZoom('${uid}',${k + 1})">›</button>` : '';
        const mc = document.getElementById('modalContent');
        mc.innerHTML = `
        <div class="modal-header"><h2 class="modal-title">📎 本段引导图 · 第 ${k + 1} / ${n} 张</h2><button class="modal-close" onclick="App.closeModal()">×</button></div>
        <div class="modal-body">
            <div class="sb-quad-viewer">
                ${navPrev}
                <div class="sb-quad-viewer-img">
                    ${url ? `<img src="${url}" alt="第${k + 1}张引导图">` : '<div class="sb-thumb-placeholder">该图已不存在</div>'}
                </div>
                ${navNext}
            </div>
            <div class="sb-quad-dots">${dots}</div>
            <div class="sb-guide-zoom-meta">
                <span class="sb-guide-zoom-name" title="${name}">${name}</span>
                <span class="sb-guide-zoom-dur">本张时长约 ${(durs[k] / fps).toFixed(1)}s</span>
            </div>
            <div class="sb-quad-viewer-actions">
                <button class="btn-secondary btn-tiny" onclick="StoryboardModule.tlRemoveGuide('${uid}',${k});App.closeModal()">🗑️ 移除这张</button>
                <button class="btn-secondary btn-tiny" onclick="StoryboardModule.tlPickGuideImages()">＋ 添加 / 管理引导图</button>
            </div>
        </div>`;
        document.getElementById('modalOverlay').classList.add('active');
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
        const transVal = c ? (c.shotTransition || '') : '';
        const transDur = c ? (Number(c.transitionDur) || 0.5) : 0.5;
        const guideHtml = c ? this._guideEditorHtml(c) : '';
        host.innerHTML = c ? `
            ${talkBar}
            ${guideHtml}
            <div class="sb-dir-prev-prompt">
                <div class="sb-dir-prev-phead">
                    <span class="sb-dir-prev-plabel">✎ 第 ${idx} 段 · local 提示词</span>
                    <span class="sb-dir-prev-phint">${tl.playing ? '播放中（跟随播放头）' : '点击上方图像段切换 · 编辑后自动保存'}</span>
                </div>
                <textarea class="form-textarea sb-dir-prev-parea" id="tlPrevPrompt"
                    placeholder="描述这一段的画面内容…（local 提示词）"
                    onfocus="StoryboardModule.tlAutoGrow(this)" onblur="StoryboardModule.tlAutoGrowReset(this)"
                    oninput="StoryboardModule.tlSetPrompt('${c.uid}', this.value);StoryboardModule.tlAutoGrow(this)">${this.esc(promptVal)}</textarea>
            </div>
            <div class="sb-dir-prev-prompt sb-dir-prev-trans">
                <div class="sb-dir-prev-phead">
                    <span class="sb-dir-prev-plabel">🎞️ 转场提示词 · 第 ${idx} 段 → 下一段</span>
                    <span class="sb-dir-trans-dur" title="转场时长（秒），合成时作为两段之间的纯文本过渡段插入">时长
                        <input type="number" min="0.5" step="0.5" value="${transDur}"
                            oninput="StoryboardModule.tlSetTransDur('${c.uid}', this.value)"> 秒
                    </span>
                </div>
                <textarea class="form-textarea sb-dir-prev-parea" id="tlPrevTrans"
                    placeholder="到下一段的转场 / 镜头语言（如：镜头由中景推近至特写、硬切到对话另一方…）。留空则不插入转场段。"
                    onfocus="StoryboardModule.tlAutoGrow(this)" onblur="StoryboardModule.tlAutoGrowReset(this)"
                    oninput="StoryboardModule.tlSetTrans('${c.uid}', this.value);StoryboardModule.tlAutoGrow(this)">${this.esc(transVal)}</textarea>
            </div>`
            : `<div class="sb-dir-prev-empty">点击上方图像段，可在此查看 / 编辑该段的 local 提示词</div>`;
        this._prevUid = c ? c.uid : null;
        this._prevTalk = talk;
    },
    // 提示词 textarea：聚焦/输入时根据内容自动擑高（展开看全），最高 320px 后内部滚动
    tlAutoGrow(el) {
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight + 2, 320) + 'px';
    },
    // 失焦时收回默认高度（留空时恢复原始紧凑高度；有内容也收回，下次点击再展开）
    tlAutoGrowReset(el) {
        if (!el) return;
        el.style.height = '';
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
        this._syncClipToStoryboard(c, 'prompt');   // 同步回原始分镜（debounce 持久化）
        const host = document.getElementById('sbDirTracks');
        const el = host && host.querySelector(`.sb-dir-clip[data-uid="${uid}"][data-kind="img"] .sb-dir-clip-body`);
        if (!el) return;
        // 普通图像段：更新块底叠加的 local 提示词 span（不整轨重绘，避免打断输入）
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
    // 编辑「转场提示词」（写回选中图像段的 shotTransition）：轻量写回，不重绘轨道，避免打断输入。
    // 合成时该段会带着 transition 文本 + transitionDur 秒发给后端，由后端自动夹在两段之间。
    tlSetTrans(uid, v) {
        const c = this._tl && this._tl.imageClips.find(x => x.uid === uid);
        if (!c) return;
        c.shotTransition = v;
        // 文本从无到有时给个默认时长，避免合成时被当作 0=不插入
        if (v && !(Number(c.transitionDur) > 0)) c.transitionDur = 0.5;
        this._syncClipToStoryboard(c, 'trans');    // 同步回原始分镜（debounce 持久化）
    },

    // 把时间轴里编辑的 local 提示词 / 转场提示词写回原始分镜并持久化（保持内外同步）。
    // field: 'prompt'=local 提示词 | 'trans'=转场提示词。用 debounce 避免 oninput 高频写盘卡顿。
    _syncClipToStoryboard(c, field) {
        if (!c || c.groupId == null) return;
        // 按 段uid:字段 维度各自 debounce，避免「快速切换不同输入框」时后一次取消前一次的写盘导致丢失
        if (!this._clipSyncTimers) this._clipSyncTimers = {};
        if (!this._clipSyncPending) this._clipSyncPending = {};
        const tkey = `${c.uid}:${field}`;
        // 记下挂起项，关闭弹窗时可立即 flush（避免「改完立刻关弹窗」时 400ms 定时器还没触发→外部显示旧值）
        this._clipSyncPending[tkey] = { c, field };
        clearTimeout(this._clipSyncTimers[tkey]);
        this._clipSyncTimers[tkey] = setTimeout(() => {
            this._writeClipToStoryboard(c, field);
            delete this._clipSyncPending[tkey];
        }, 400);
    },
    // 立即把单个 clip 的某字段写回原始分镜并持久化（不重绘外部，供 debounce / flush 复用）
    _writeClipToStoryboard(c, field) {
        if (!c || c.groupId == null) return;
        const p = Storage.getProject(this.projectId);
        const g = (p.storyboardGroups || []).find(x => x.id === c.groupId);
        if (!g) return;
        if (field === 'prompt') {
            if (c.single) {
                g.prompt = c.prompt || '';
            } else {
                if (!Array.isArray(g.localPrompts)) g.localPrompts = ['', '', '', ''];
                g.localPrompts[c.panel] = c.prompt || '';
            }
        } else if (field === 'trans') {
            if (!Array.isArray(g.shotTransitions)) g.shotTransitions = ['', '', '', ''];
            g.shotTransitions[c.panel] = c.shotTransition || '';
        }
        Storage.updateProject(this.projectId, { storyboardGroups: p.storyboardGroups });
    },
    // 立即冲刷所有挂起的同步定时器（关闭弹窗前调用，保证外部列表 render 时拿到的是最新值）
    _flushClipSync() {
        const timers = this._clipSyncTimers || {};
        const pending = this._clipSyncPending || {};
        Object.keys(timers).forEach(k => clearTimeout(timers[k]));
        Object.keys(pending).forEach(k => {
            const { c, field } = pending[k];
            this._writeClipToStoryboard(c, field);
        });
        this._clipSyncTimers = {};
        this._clipSyncPending = {};
    },
    // 编辑转场时长（秒）
    tlSetTransDur(uid, v) {
        const c = this._tl && this._tl.imageClips.find(x => x.uid === uid);
        if (!c) return;
        const sec = Math.max(0.5, Number(v) || 0.5);
        c.transitionDur = sec;
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
        this._stopVideoTimer();   // 仅停 UI 计时器；后台任务与轮询继续
        this._flushClipSync();    // 先把挂起的提示词同步立即写盘，保证下面 render 拿到最新值
        this._tl = null; App.closeModal(); this.render(this.projectId);
    },

    // 生成视频前的二次确认：让用户确认/临时修改本次使用的「合成工作流」，确认后才真正提交。
    // 注意：时间轴本身占用 #modalContent，这里用独立浮层覆盖在最上层，避免覆盖掉时间轴弹窗。
    confirmGenVideo() {
        const tl = this._tl;
        if (!tl || !tl.imageClips.length) { App.showToast('请至少保留一个图像段', 'error'); return; }
        // 已有进行中的浮层先移除，避免叠加
        const old = document.getElementById('sbGenConfirmMask');
        if (old) old.remove();
        const cur = tl.workflow || 'director';
        const mask = document.createElement('div');
        mask.id = 'sbGenConfirmMask';
        mask.className = 'sb-genconfirm-mask';
        mask.innerHTML = `
            <div class="sb-genconfirm-box">
                <div class="modal-header"><h2 class="modal-title">🎬 确认合成视频</h2></div>
                <div class="modal-body" style="padding:1rem 1.25rem">
                    <p style="margin:0 0 .75rem;line-height:1.6">即将开始合成视频，请确认本次使用的<b>合成工作流</b>（可在此临时修改）：</p>
                    <label class="sb-dir-selwrap" style="display:flex;align-items:center;gap:.5rem">
                        <span style="white-space:nowrap">合成工作流</span>
                        <span class="sb-dir-select" style="flex:1">
<select id="sbGenConfirmWf" style="width:100%">
<option value="director" ${cur === 'director' ? 'selected' : ''}>旧导演台 LTXDirector</option>
<option value="singularity" ${cur === 'singularity' ? 'selected' : ''}>Singularity 乱神版V3</option>
<option value="yusu" ${cur === 'yusu' ? 'selected' : ''}>Yusu 导演台</option>
</select>
                        </span>
                    </label>
                    <p style="margin:.75rem 0 0;font-size:.82rem;color:var(--text-secondary,#888)">提示：默认工作流可在「设置」中修改。</p>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="StoryboardModule._closeGenConfirm()">取消</button>
                    <button class="btn-primary" onclick="StoryboardModule._doConfirmGenVideo()">✅ 确认并生成</button>
                </div>
            </div>`;
        document.body.appendChild(mask);
    },

    _closeGenConfirm() {
        const m = document.getElementById('sbGenConfirmMask');
        if (m) m.remove();
    },

    // 读取确认框里选定的工作流 → 写回时间轴（含下拉同步）→ 关闭浮层 → 真正提交
    _doConfirmGenVideo() {
        const sel = document.getElementById('sbGenConfirmWf');
if (sel && this._tl) {
const wf = (sel.value === 'singularity' || sel.value === 'yusu') ? sel.value : 'director';
this._tl.workflow = wf;
            // 同步时间轴工具栏里的工作流下拉，保持显示一致
            const tlSel = document.getElementById('tlWorkflow');
            if (tlSel) tlSel.value = wf;
        }
        this._closeGenConfirm();
        this.genVideo();
    },

    async genVideo() {
        const tl = this._tl;
        if (!tl || !tl.imageClips.length) { App.showToast('请至少保留一个图像段', 'error'); return; }
        // 生成中禁止再次发起，直到完成/失败/打断结束。
        // 但本地可能残留「陈旧任务」（如后端重启过）—— 先向后端核实是否仍存活，
        // 已失效（missing / 查询失败）则清掉本地任务并放行，避免永久卡住无法再生成。
        const existing = this._loadVideoTask();
        if (existing) {
            let alive = false;
            try {
                const r = await API.post('/api/sb_task', { task_id: existing.task_id });
                alive = r && r.success && ['pending', 'running'].includes(r.status);
            } catch (e) { alive = false; }
            if (alive) { App.showToast('已有视频生成任务进行中，请等待完成或先打断', 'info'); return; }
            // 任务已不存在/已结束 → 清理残留，继续发起新任务
            this._clearVideoTask(); this._stopVideoTimer(); this._videoPolling = null;
            this._syncVideoUI();
        }
        if (tl.playing) this.tlTogglePlay();
        const resEl = document.getElementById('tlVideoResult');
        // 新一次生成：清掉上次失败横幅
        this._clearVideoErr(); this._renderVideoErrBanner();
        resEl.innerHTML = '<div class="sb-cc-running"><div class="sb-spinner"></div> 正在准备素材…</div>';

        // 【关键修复】转场段是「紧跟图像段末尾」插入的（后端按图像段 length 定位）。
        // 若图像段 length 仍是默认 3s、而音频是 9s，转场就会在第 3s 插进来、把 9s 语音拦腰打断
        //（现象：A 画面只到第 3s，转场随机画面占到第 9s，语音第 9s 才说完）。
        // 之前依赖 _loadAudioDurations 的异步副作用对齐 img.length，但它可能因 imgUid 关联断裂、
        // 探测失败被静默吞掉、或时序竞态而不生效。这里改为「同步、就地」探测每段音频真实时长，
        // 直接用它决定每个图像段要发给后端的 length —— 不依赖任何前置副作用，最稳。
        const probe = (url) => new Promise((res) => {
            try {
                const a = new Audio(); a.preload = 'metadata';
                a.onloadedmetadata = () => {
                    const d = a.duration;
                    // 某些容器 metadata 给出 Infinity/NaN —— 视为探测失败（返回 0），避免 length 爆炸
                    res((isFinite(d) && d > 0) ? d : 0);
                };
                a.onerror = () => res(0);
                a.src = url;
                // 兜底超时：3s 内没拿到 metadata 就放弃（避免卡住生成）
                setTimeout(() => res(0), 3000);
            } catch (e) { res(0); }
        });
        // 先把每个音频段的真实时长探测出来（帧），回填到 clip 上。
        for (const a of tl.audioClips) {
            if (a.audioDurationFrames || a.audioId == null) continue;
            const m = Storage.getMediaById(this.projectId, a.audioId);
            if (!m) continue;
            const dur = await probe(Storage.mediaUrl(m.data));
            a.audioDurationFrames = Math.max(0, Math.round(dur * tl.fps));
            console.log('[genVideo] 探测音频', { audioId: a.audioId, imgUid: a.imgUid, durSec: dur, frames: a.audioDurationFrames, url: Storage.mediaUrl(m.data) });
        }
        // 诊断：打印图像段与音频段的关联全貌（定位为何某些段没拉伸）
        console.log('[genVideo] 图像段：', tl.imageClips.map((c, i) => ({ i, uid: c.uid, start: c.start, length: c.length, hasText: !!(c.shotTransition || '').trim() })));
        console.log('[genVideo] 音频段：', tl.audioClips.map((a, i) => ({ i, audioId: a.audioId, imgUid: a.imgUid, start: a.start, frames: a.audioDurationFrames, text: (a.text || '').slice(0, 10) })));
        // 每个图像段 uid → 其关联音频段的真实时长（帧）。
        // 优先用 imgUid 显式关联；若关联缺失（手动加的音频等），退回按时间重叠匹配，
        // 确保「图像段时长 ≥ 落在它身上的音频时长」，从根本上保证转场落在语音之后。
        // 图像段需要的最小长度 = 关联音频时长 + 前留白 + 后留白（前后留白秒数可在设置中调）。
        const { head: PAD_HEAD, tail: PAD_TAIL } = this._audioPadFrames();
        const audLenByImg = {};
        const imgClipsSorted = [...tl.imageClips].sort((a, b) => a.start - b.start);
        for (const a of tl.audioClips) {
            const frames = a.audioDurationFrames || a.length || 0;
            if (!frames) continue;
            let img = a.imgUid ? tl.imageClips.find(x => x.uid === a.imgUid) : null;
            if (!img) {
                // 按时间重叠兜底：音频 start 落在哪个图像段区间，就归给哪个段
                img = imgClipsSorted.find(c => a.start >= c.start && a.start < c.start + (c.length || 0))
                      || imgClipsSorted[imgClipsSorted.length - 1];
            }
            // 图像段要比音频多出前后留白，保证画面在语音前/后各多留一段
            if (img) audLenByImg[img.uid] = Math.max(audLenByImg[img.uid] || 0, frames + PAD_HEAD + PAD_TAIL);
        }
        // 把图像段 length 就地对齐到「自身与其音频的较大值」，并重新紧贴布局（ripple），
        // 让后续段 start、音频 start、totalFrames 全部跟着更新到正确位置。
        let aligned = false;
        for (const c of tl.imageClips) {
            const need = audLenByImg[c.uid] || 0;
            if (need > (c.length || 0)) { c.length = need; aligned = true; }
        }
        if (aligned) {
            this._relayoutImages();                       // 图像轨重排：start 跟随新 length
            tl.audioClips.forEach(a => {                  // 音频跟随各自图像段 start 对齐
                const img = a.imgUid ? tl.imageClips.find(x => x.uid === a.imgUid) : null;
                if (img) {
                    // 图像段比音频长（含前后留白）时，音频在段内后移「前留白」帧，保留语音前的画面
                    const pad = (img.length > (a.audioDurationFrames || a.length || 0)) ? PAD_HEAD : 0;
                    a.start = img.start + pad;
                }
            });
            const far = tl.imageClips.reduce((mx, c) => Math.max(mx, c.start + c.length), 0);
            if (far > 0) tl.totalFrames = far;            // 总长扩到容纳拉伸后的图像轨
        }

        // 保险：把总长收敛为「图像轨实际最远端」，避免末尾留出无图引导的空白帧
        // （否则 LTX 会在该无主区间按工作流默认模板手感自由衍生，导致结尾出现无关画面，如 F1 模板）。
        const imgFar = tl.imageClips.reduce((mx, c) => Math.max(mx, c.start + c.length), 0);
        if (imgFar > 0) tl.totalFrames = imgFar;
        // 仅纳入落在总时长范围内（start < totalFrames）的块；length 截断到不超过总长
        const total = tl.totalFrames;
        const clampLen = (c) => Math.max(1, Math.min(c.length, total - c.start));

        const imageSegments = [];
        for (const c of [...tl.imageClips].sort((a, b) => a.start - b.start)) {
            if (c.start >= total) continue;                 // 完全超出 → 不合成
            // 空段跳过：既没有图（非白场、无 imageId）又没有提示词/台词的段不发，
            // 否则时间轴会出现缺 prompt 的 segment → LTXDirector 报错。
            const segPrompt = (c.prompt || (c.dialogue && c.dialogue.text) || '').trim();
            // 本段的引导图列表（多图关键帧）：优先用 guideImageIds，缺省退回单图 imageId。
            const guideIds = this._clipGuideIds(c);
            const hasImage = c.whiteFrame || guideIds.length > 0;
            if (!hasImage && !segPrompt) continue;

            // 转场「附着」在图像段上：把该段的转场文字 + 时长一并带给后端，
            // 后端会自动在相邻两段之间插入「无图纯文本转场段」并顺延音频（不用手动摆位置）。
            // 全局「禁用转场」开启时：不拼接转场段（文本清空、时长置 0）；未禁用时保持现状。
            const transOff = !!Storage.getSettings().disableTransition;
            const tText = transOff ? '' : (c.shotTransition || '').trim();
            // 图像段最终 length：取「时间轴长度」与「关联音频时长」的较大值，双保险确保转场落在语音之后。
            const segLen = Math.max(clampLen(c), audLenByImg[c.uid] || 0);

            // ===== 白场 / 无引导图：保持单段逻辑 =====
            if (c.whiteFrame || guideIds.length <= 1) {
                let b64;
                if (c.whiteFrame) {
                    b64 = this._whiteFrameB64();
                } else {
                    const img = guideIds.length ? Storage.getMediaById(this.projectId, guideIds[0]) : null;
                    if (!img) continue;
                    b64 = await this._urlToB64(Storage.mediaUrl(img.data));
                }
                imageSegments.push({
                    image_b64: b64,
                    prompt: c.prompt || (c.dialogue && c.dialogue.text) || '',
                    start: c.start, length: segLen,
                    transition: tText,
                    transition_dur: tText ? (Number(c.transitionDur) || 0.5) : 0,
                    // 分组标识：乱神（Singularity）工作流据此把同一四宫格组的多张图聚合成「一段多图（多帧）」；
                    // 其他工作流（director/yusu）不读这两个字段，仍逐段一图，互不影响。
                    group_id: c.groupId != null ? String(c.groupId) : '',
                    panel: (c.panel != null ? c.panel : 0),
                });
                continue;
            }

            // ===== 多张引导图：就地展开成多个连续子段 =====
            // 把本段总时长 segLen 按 guideDurs 分配给每张图（无 guideDurs 则平分），
            // 每个子段一张图、共享同一 prompt（台词只挂第一张子段，避免重复配音），
            // 子段之间硬切（无转场），只有「整段最后一张子段」带上本段的转场文字。
            const durs = this._clipGuideDurs(c, guideIds.length, segLen);
            const firstPrompt = c.prompt || (c.dialogue && c.dialogue.text) || '';
            let subStart = c.start;
            for (let k = 0; k < guideIds.length; k++) {
                const img = Storage.getMediaById(this.projectId, guideIds[k]);
                if (!img) continue;
                const b64 = await this._urlToB64(Storage.mediaUrl(img.data));
                const isLast = k === guideIds.length - 1;
                imageSegments.push({
                    image_b64: b64,
                    // 提示词每张子段都带（保证 LTXDirector 不报缺 prompt），台词文本仅第一张带
                    prompt: firstPrompt,
                    start: subStart, length: durs[k],
                    // 转场只挂最后一张子段 → 整段结束后才过渡到下一分镜；段内各图之间硬切衔接
                    transition: isLast ? tText : '',
                    transition_dur: isLast && tText ? (Number(c.transitionDur) || 0.5) : 0,
                    group_id: c.groupId != null ? String(c.groupId) : '',
                    panel: (c.panel != null ? c.panel : 0),
                });
                subStart += durs[k];
            }
        }
        // 至少要有一个带图的段（编辑接口/合成需要画面）
        if (!imageSegments.length) { resEl.innerHTML = '<div class="sb-err">❌ 没有落在总时长范围内的图像段</div>'; return; }
        // 诊断：打印最终发给后端的图像段（重点看 length 是否已拉到音频时长、转场是否带上）
        console.log('[genVideo] 最终图像段(发给后端)：', imageSegments.map(s => ({ length: s.length, transition: s.transition, transition_dur: s.transition_dur, promptHead: (s.prompt || '').slice(0, 12) })));
        console.log('[genVideo] audLenByImg=', audLenByImg, ' totalFrames=', total);

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
                epsilon: (this._tl.epsilon ?? 0.9),
                guide_strength: tl.guideStrength || '1.00',
                max_guide_strength: parseFloat(tl.guideStrength || '1.00'),   // 每段引导强度上限
                use_custom_audio: (tl.useCustomAudio !== false) && audioSegments.length > 0,
                fps: tl.fps,
                workflow: tl.workflow || 'director',   // 导演台工作流：director(默认) | singularity
                resolution: tl.resolution || '1280 x 720 (16:9)',   // 生成视频分辨率
            });
            if (!submit.success || !submit.task_id) throw new Error(submit.error || '提交失败');
            // 持久化任务：关弹窗 / 刷新后仍可恢复计时与轮询
            this._saveVideoTask({ task_id: submit.task_id, start: Date.now(), projectId: this.projectId, totalFrames: total, fps: tl.fps, groupFrom: tl.groupFrom || 1, groupTo: tl.groupTo || 1 });
            this._startVideoTimer();
            this._pollVideoTask(submit.task_id);
            this._syncVideoUI();
        } catch (e) {
            this._saveVideoErr('视频生成失败：' + (e.message || e));
            this._renderVideoErrBanner();
            resEl.innerHTML = '';
            this._syncVideoUI();
        }
    },

    // ⏹ 打断：真实中断后台 ComfyUI 执行（调用 /api/sb_cancel）
    async cancelVideo() {
        const t = this._loadVideoTask();
        if (!t) return;
        const ok = await App.confirm({
            title: '⏹ 打断生成',
            message: '确定打断本次视频生成？\n\n会真实中断 ComfyUI 当前的渲染任务。',
            okText: '打断',
            cancelText: '继续等待',
            danger: true,
        });
        if (!ok || !this._loadVideoTask()) return;
        const btn = document.getElementById('tlCancelBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏹ 打断中…'; }
        let r = null;
        try {
            r = await API.post('/api/sb_cancel', { task_id: t.task_id });
        } catch (e) {
            r = null;   // 网络错误 / 接口不存在（旧后端 404）
        }
        if (r && r.success) {
            // 后端已受理打断：主动停轮询并立即收尾（不必干等下一轮），ComfyUI 会被真实中断
            this._videoPolling = null;
            this._clearVideoTask(); this._stopVideoTimer();
            const resEl = document.getElementById('tlVideoResult');
            if (resEl) resEl.innerHTML = '<div class="sb-dir-cur">⏹ 已打断本次生成</div>';
            this._syncVideoUI();
            App.showToast('⏹ 已打断视频生成', 'info');
        } else {
            // 后端无打断接口或调用失败 → 前端停止跟踪以恢复可用（提示用户后端可能需重启）
            this._videoPolling = null;
            this._clearVideoTask(); this._stopVideoTimer();
            const resEl = document.getElementById('tlVideoResult');
            if (resEl) resEl.innerHTML = '<div class="sb-dir-cur">⏹ 已停止跟踪（后端打断接口不可用，后台任务可能仍在运行，请重启后端以启用真实打断）</div>';
            this._syncVideoUI();
            App.showToast('⚠️ 后端打断接口不可用，已前端停止跟踪。请重启后端启用真实打断', 'error');
        }
    },

    // 视频生成计时器：每秒刷新「生成中 Ns」（弹窗开着才更新 DOM）
    _startVideoTimer() {
        this._stopVideoTimer();
        const tick = () => {
            if (!this._loadVideoTask()) { this._stopVideoTimer(); return; }
            this._syncVideoUI();
        };
        tick();
        this._videoTimer = setInterval(tick, 1000);
    },
    _stopVideoTimer() {
        if (this._videoTimer) { clearInterval(this._videoTimer); this._videoTimer = null; }
    },

    // 根据当前任务状态刷新弹窗内按钮 / 结果区（弹窗可能未打开，此时静默跳过 DOM）
    _syncVideoUI() {
        const btn = document.getElementById('tlGenBtn');
        const cancelBtn = document.getElementById('tlCancelBtn');
        const resEl = document.getElementById('tlVideoResult');
        if (!btn) return;   // 弹窗未打开
        const t = this._loadVideoTask();
        if (t) {
            const sec = Math.round((Date.now() - (t.start || Date.now())) / 1000);
            btn.disabled = true; btn.textContent = `⏳ 生成中 ${sec}s`;
            if (cancelBtn) {
                cancelBtn.style.display = '';
                if (cancelBtn.textContent.indexOf('打断中') < 0) { cancelBtn.disabled = false; cancelBtn.textContent = '⏹ 打断'; }
            }
            if (resEl && !resEl.querySelector('.sb-result-video')) {
                resEl.innerHTML = `<div class="sb-cc-running"><div class="sb-spinner"></div> 渲染中… 已用 ${sec}s（总长 ${((t.totalFrames || 0) / (t.fps || 30)).toFixed(1)}s）</div>`;
            }
        } else {
            btn.disabled = false;
            if (cancelBtn) { cancelBtn.style.display = 'none'; cancelBtn.disabled = false; cancelBtn.textContent = '⏹ 打断'; }
        }
    },

    // 视频任务轮询：done→展示视频；error→顶部失败横幅；cancelled→静默收尾
    _pollVideoTask(taskId) {
        this._videoPolling = taskId;
        const interval = 1500;
        const tick = async () => {
            if (this._videoPolling !== taskId) return;   // 已被新任务/收尾替换
            try {
                const r = await API.post('/api/sb_task', { task_id: taskId });
                if (!r.success) throw new Error(r.error || '查询失败');
                if (r.status === 'done') { this._onVideoDone(r.result || {}); return; }
                if (r.status === 'error') {
                    this._clearVideoTask(); this._stopVideoTimer(); this._videoPolling = null;
                    this._saveVideoErr('视频生成失败：' + (r.error || '未知错误'));
                    this._renderVideoErrBanner();
                    const resEl = document.getElementById('tlVideoResult'); if (resEl) resEl.innerHTML = '';
                    this._syncVideoUI();
                    return;
                }
                if (r.status === 'cancelled') {
                    this._clearVideoTask(); this._stopVideoTimer(); this._videoPolling = null;
                    const resEl = document.getElementById('tlVideoResult'); if (resEl) resEl.innerHTML = '<div class="sb-dir-cur">⏹ 已打断本次生成</div>';
                    this._syncVideoUI();
                    App.showToast('⏹ 已打断视频生成', 'info');
                    return;
                }
                if (r.status === 'missing') {
                    this._clearVideoTask(); this._stopVideoTimer(); this._videoPolling = null;
                    this._saveVideoErr('视频任务已失效（服务可能已重启）');
                    this._renderVideoErrBanner();
                    this._syncVideoUI();
                    return;
                }
                setTimeout(tick, interval);   // pending / running
            } catch (e) {
                setTimeout(tick, interval * 2);   // 网络抖动退避
            }
        };
        tick();
    },

    // 用 Web Audio 合成一段轻快的「叮—咚」提示音（无需音频文件）。
    // 视频生成成功后播放，提醒用户回来查看结果。
    _playDoneChime() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const now = ctx.currentTime;
            // 两个上行音符：C6 → E6，营造「完成」感
            const notes = [{ f: 1047, t: 0 }, { f: 1319, t: 0.16 }];
            notes.forEach(({ f, t }) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = f;
                const s = now + t;
                gain.gain.setValueAtTime(0.0001, s);
                gain.gain.exponentialRampToValueAtTime(0.25, s + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.35);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(s); osc.stop(s + 0.4);
            });
            setTimeout(() => { try { ctx.close(); } catch (e) {} }, 1000);
        } catch (e) { /* 忽略：浏览器不支持或被策略拦截 */ }
    },

    _onVideoDone(result) {
        const task = this._loadVideoTask() || {};
        this._clearVideoTask(); this._stopVideoTimer(); this._videoPolling = null;
        this._syncVideoUI();
        const resEl = document.getElementById('tlVideoResult');
        if (result && result.video_base64) {
            // 写入「视频历史」：索引到 ComfyUI 生成目录（不复制、不存 base64），命名「分镜X-Y(N)」
            this._addVideoHistory({
                file: result.video_file || '',
                rawName: result.video_name || '',
                frames: result.frames || 0,
                groupFrom: (this._tl && this._tl.groupFrom) || task.groupFrom || 1,
                groupTo: (this._tl && this._tl.groupTo) || task.groupTo || 1,
            });
            if (resEl) {
                const dataUrl = 'data:video/mp4;base64,' + result.video_base64;
                resEl.innerHTML = `<video class="sb-result-video" controls autoplay src="${dataUrl}"></video>
                    <div class="sb-dir-cur" style="margin-top:.5rem">✅ 生成成功（${result.frames || 0} 帧）。已存入「视频历史」，可在分镜页切到该 tab 拖放到剪辑软件。</div>`;
                const btn = document.getElementById('tlGenBtn'); if (btn) btn.textContent = '🔄 重新生成';
            }
            this._playDoneChime();                          // 成功提示音
            App.showToast('🎬 视频生成完成，已存入视频历史', 'success');
        } else {
            this._saveVideoErr('视频生成失败：未产出视频');
            this._renderVideoErrBanner();
        }
    },

    // 写入视频历史：同一「分镜X-Y」组合自动累加序号 (0)(1)(2)…
    _addVideoHistory({ file, rawName, frames, groupFrom, groupTo }) {
        const p = Storage.getProject(this.projectId);
        const list = Array.isArray(p.storyboardVideos) ? p.storyboardVideos.slice() : [];
        const baseName = `分镜${groupFrom}-${groupTo}`;
        // 同一 base 已有多少条 → 决定本次序号
        const seq = list.filter(v => v.baseName === baseName).length;
        list.push({
            id: Storage._uid(),
            file: file || '',           // ComfyUI 生成目录的绝对路径（索引，不复制）
            rawName: rawName || '',     // ComfyUI 原始文件名
            frames: frames || 0,
            groupFrom, groupTo,
            baseName,                   // 「分镜X-Y」
            seq,                        // 该组合内的序号
            createdAt: Date.now(),
        });
        Storage.updateProject(this.projectId, { storyboardVideos: list });
    },

    // 视频文件可直接 GET 的 URL（后端按绝对路径流式返回，不复制）
    _videoFileUrl(file) {
        if (!file) return '';
        const base = (Storage.API || '').replace(/\/$/, '');
        return `${base}/api/video_file?path=${encodeURIComponent(file)}`;
    },

    // ============================================================
    // 「视频历史」tab：列出已生成视频，命名「分镜X-Y(N)」，可播放/拖放/删除（索引磁盘文件，不复制）
    // ============================================================
    renderVideoHistory(projectId) {
        this.projectId = projectId;
        const p = Storage.getProject(projectId);
        const list = Array.isArray(p.storyboardVideos) ? p.storyboardVideos.slice() : [];
        const sortMode = p.vhSort || 'time';   // custom 手动拖拽 / time 生成时间 / name 名称（默认按生成时间）
        const sortDir = p.vhSortDir || 'asc';  // asc 正序（旧→新）/ desc 倒序（新→旧），默认正序
        this._vhSortList(list, sortMode, sortDir);

        const host = document.getElementById('tabContent');
        const head = `
            <div class="sb-vh-head">
                <span class="sb-count">共 ${list.length} 个视频</span>
                <button class="btn-secondary btn-tiny" onclick="StoryboardModule.refreshVideoHistory()" title="刷新：重新读取最新历史记录并重新校验视频文件是否可用（合成完成或在别处变更后可手动刷新）">🔄 刷新</button>
                <button class="btn-secondary btn-tiny" onclick="StoryboardModule.pickImportVideo()" title="选择本地视频导入：后端落盘一次后索引该路径（之后不再复制），可播放/重命名/拖到剪辑软件">📥 导入视频</button>
                <input type="file" id="vhImportInput" accept="video/*,.mp4,.webm,.mov,.mkv,.avi,.gif" multiple style="display:none" onchange="StoryboardModule.onImportVideoInput(event)">
                <label class="sb-vh-sortwrap" title="排序方式：手动拖拽 / 按生成时间 / 按名称">排序
                    <select class="sb-dir-select" onchange="StoryboardModule.setVhSort(this.value)">
                        <option value="custom" ${sortMode === 'custom' ? 'selected' : ''}>手动拖拽</option>
                        <option value="time" ${sortMode === 'time' ? 'selected' : ''}>生成时间</option>
                        <option value="name" ${sortMode === 'name' ? 'selected' : ''}>名称</option>
                    </select>
                </label>
                ${(sortMode === 'time' || sortMode === 'name') ? `<button class="btn-secondary btn-tiny" onclick="StoryboardModule.toggleVhSortDir()" title="切换正序 / 倒序">${sortDir === 'desc' ? '⬇️ 倒序' : '⬆️ 正序'}</button>` : ''}
            </div>`;

        // 整个历史 tab 作为拖放导入区：拖入文件时整界面高亮（拖出/排序不带 Files，不会误触发）
        const rootOpen = `<div class="sb-vh-root" id="vhDropZone"
                ondragover="StoryboardModule.onImportVideoDragOver(event)"
                ondragleave="StoryboardModule.onImportVideoDragLeave(event)"
                ondrop="StoryboardModule.onImportVideoDrop(event)">
                <div class="sb-vh-dropmask">⬇️ 松开即可导入视频（自动索引到生成/导入目录，不重复复制）</div>`;
        const rootClose = `</div>`;

        if (!list.length) {
            host.innerHTML = head + rootOpen + `<div class="empty-state"><div class="empty-state-icon">🎞️</div>
                <div class="empty-state-text">还没有视频。在「分镜」页合成，或点「导入视频」/把视频文件拖到本界面任意位置即可。</div></div>` + rootClose;
            return;
        }
        const canDrag = (sortMode === 'custom');
        const rows = list.map(v => this._vhCardHtml(v, canDrag)).join('');

        host.innerHTML = head + rootOpen + `<div class="sb-vh-grid">${rows}</div>` + rootClose;
    },

    // 生成单个视频历史卡片的 HTML（renderVideoHistory 与增量刷新共用）
    _vhCardHtml(v, canDrag) {
        const name = this._vhDisplayName(v);
        const fname = `${name}.mp4`.replace(/[\\/:*?"<>|]/g, '_');
        const url = this._videoFileUrl(v.file);
        const missing = !v.file;
        const when = v.createdAt ? new Date(v.createdAt).toLocaleString() : '';
        const watched = !!v.watched;
        const tag = v.imported ? ' <span class="sb-vh-tag sb-vh-tag-imp">导入</span>' : '';
        const mime = /\.webm$/i.test(fname) ? 'video/webm' : /\.mov$/i.test(fname) ? 'video/quicktime' : /\.gif$/i.test(fname) ? 'image/gif' : 'video/mp4';
        // 视频画面本身可拖出到剪辑软件（DownloadURL）；controls 仍可点击播放
        const videoEl = (!missing && url)
            ? `<video class="sb-vh-video" controls preload="metadata" src="${url}" draggable="true"
                   ondragstart="App.onAudioDragStart(event, '${url.replace(/'/g, "\\'")}', '${fname.replace(/'/g, "\\'")}', '${mime}')"
                   title="按住画面拖到剪辑软件/桌面即可导出该视频"></video>`
            : `<div class="sb-vh-missing">⚠️ 未索引到视频文件（可能 ComfyUI 输出已清理或非同机）</div>`;
        // 删除移到右上角
        const delBtn = `<button class="sb-vh-del" onclick="StoryboardModule.delVideoHistory('${v.id}')" title="从历史中删除（仅移除索引记录，不会删除磁盘上的原视频文件）">✕</button>`;
        // 手动拖拽排序把手
        const handle = canDrag
            ? `<span class="sb-vh-handle" draggable="true"
                   ondragstart="StoryboardModule.onVhSortDragStart(event,'${v.id}')"
                   title="按住拖拽调整顺序">⠿</span>`
            : '';
        return `<div class="sb-vh-card ${watched ? 'is-watched' : ''}" data-vid="${v.id}"
                ${canDrag ? `ondragover="StoryboardModule.onVhSortDragOver(event)" ondrop="StoryboardModule.onVhSortDrop(event,'${v.id}')" ondragleave="this.classList.remove('vh-drop-target')"` : ''}>
            <div class="sb-vh-thumb">
                ${handle}
                ${delBtn}
                ${videoEl}
            </div>
            <div class="sb-vh-meta">
                <div class="sb-vh-name" title="${this.esc(v.file || '')}">${this.esc(name)}${tag}${watched ? ' <span class="sb-vh-tag sb-vh-tag-watched">已看</span>' : ''}</div>
                <div class="sb-vh-sub">${v.frames ? v.frames + ' 帧 · ' : ''}${when}</div>
                <div class="sb-vh-acts">
                    ${(!missing && url) ? App.videoDragHandle(url, fname, '拖到剪辑软件') : ''}
                    <button class="btn-ghost btn-tiny" onclick="StoryboardModule.renameVideoHistory('${v.id}')" title="重命名：自定义该视频的显示名（同时影响拖出的文件名）">✏️ 重命名</button>
                    ${(!missing) ? `<button class="btn-ghost btn-tiny" onclick="StoryboardModule.openVideoPath('${v.id}')" title="在系统文件管理器中定位该视频文件（需 backend 与浏览器同机）">📂 打开路径</button>` : ''}
                    <button class="btn-ghost btn-tiny sb-vh-markbtn ${watched ? 'on' : ''}" onclick="StoryboardModule.toggleVideoWatched('${v.id}')" title="标记为已看：点击后本卡片置灰，便于区分哪些已播放（可再次点击取消）">${watched ? '↺ 标记已看' : '✓ 标记已看'}</button>
                </div>
            </div>
        </div>`;
    },

    // 整界面拖入：仅在拖拽的是文件（含 Files）时高亮 + 接收，避免拖出视频/排序拖拽误触发
    _dragHasFiles(ev) {
        const t = ev.dataTransfer && ev.dataTransfer.types;
        if (!t) return false;
        return Array.prototype.indexOf.call(t, 'Files') !== -1;
    },
    onImportVideoDragOver(ev) {
        if (!this._dragHasFiles(ev)) return;   // 拖出/排序不带 Files → 不拦截
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        const zone = ev.currentTarget;
        if (zone) zone.classList.add('drag-over');
    },
    onImportVideoDragLeave(ev) {
        const zone = ev.currentTarget;
        // 仅当真正离开容器（而非进入子元素）时移除高亮
        if (zone && !zone.contains(ev.relatedTarget)) zone.classList.remove('drag-over');
    },

    // 按当前排序模式对列表排序（custom 用 order，缺省回退到原分镜组顺序）
    // dir：'asc' 正序 / 'desc' 倒序（仅对 time / name 生效）
    _vhSortList(list, mode, dir) {
        const sign = (dir === 'desc') ? -1 : 1;
        if (mode === 'time') {
            list.sort((a, b) => sign * ((a.createdAt || 0) - (b.createdAt || 0)));   // asc：旧→新
        } else if (mode === 'name') {
            list.sort((a, b) => sign * this._vhDisplayName(a).localeCompare(this._vhDisplayName(b), 'zh-Hans-CN'));
        } else {
            // custom：优先 order 字段；无 order 的回退到「分镜组号→seq→时间」
            list.sort((a, b) => {
                const ao = (a.order != null), bo = (b.order != null);
                if (ao && bo) return a.order - b.order;
                if (ao) return -1;
                if (bo) return 1;
                return (a.groupFrom - b.groupFrom) || (a.groupTo - b.groupTo) || (a.seq - b.seq) || (a.createdAt - b.createdAt);
            });
        }
        return list;
    },

    // 切换排序方式
    setVhSort(mode) {
        Storage.updateProject(this.projectId, { vhSort: mode });
        this.renderVideoHistory(this.projectId);
    },

    // 切换正序 / 倒序（asc ↔ desc），仅对 生成时间 / 名称 生效
    toggleVhSortDir() {
        const p = Storage.getProject(this.projectId);
        const next = (p.vhSortDir === 'desc') ? 'asc' : 'desc';
        Storage.updateProject(this.projectId, { vhSortDir: next });
        this.renderVideoHistory(this.projectId);
    },

    // 打开视频所在路径（系统文件管理器中定位）
    async openVideoPath(id) {
        const p = Storage.getProject(this.projectId);
        const v = (p.storyboardVideos || []).find(x => x.id === id);
        if (!v || !v.file) { App.showToast('该视频未索引到本机路径', 'error'); return; }
        try {
            const r = await API.post('/api/open_path', { path: v.file });
            if (!r || !r.success) throw new Error((r && r.error) || '打开失败');
        } catch (e) {
            App.showToast(`打开路径失败：${e.message || e}`, 'error');
        }
    },

    // ===== 手动拖拽排序 =====
    onVhSortDragStart(ev, id) {
        this._vhDragId = id;
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', id); } catch (e) {}
    },
    onVhSortDragOver(ev) {
        if (!this._vhDragId) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        const card = ev.currentTarget;
        if (card) card.classList.add('vh-drop-target');
    },
    onVhSortDrop(ev, targetId) {
        ev.preventDefault();
        const card = ev.currentTarget; if (card) card.classList.remove('vh-drop-target');
        const fromId = this._vhDragId; this._vhDragId = null;
        if (!fromId || fromId === targetId) return;
        const p = Storage.getProject(this.projectId);
        const list = (p.storyboardVideos || []).slice();
        // 先按当前显示顺序确定基准序列
        this._vhSortList(list, p.vhSort || 'custom');
        const fromIdx = list.findIndex(v => v.id === fromId);
        const toIdx = list.findIndex(v => v.id === targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = list.splice(fromIdx, 1);
        list.splice(toIdx, 0, moved);
        // 重新写入 order，并切到 custom 模式（手动拖拽即固定该顺序）
        list.forEach((v, i) => { v.order = i; });
        Storage.updateProject(this.projectId, { storyboardVideos: list, vhSort: 'custom' });
        this.renderVideoHistory(this.projectId);
    },

    // 显示名：用户重命名优先；否则合成视频用「分镜X-Y(N)」，导入视频用原文件名（去扩展名）
    _vhDisplayName(v) {
        if (v.displayName && v.displayName.trim()) return v.displayName.trim();
        // 默认显示文件本来的名字（ComfyUI 生成的原始文件名 / 导入文件名，去扩展名）
        if (v.rawName && v.rawName.trim()) return v.rawName.replace(/\.[^.]+$/, '');
        if (v.imported) return '导入视频';
        // 兜底：无原始文件名时才用「分镜X-Y(N)」
        return `${v.baseName}(${v.seq})`;
    },

    // 手动刷新视频历史：重新从最新工程读取记录并重渲染（重新校验文件可用性、刷新缩略/排序）
async refreshVideoHistory() {
const pid = this.projectId;
// 1. 先从后端重新拉取最新项目数据（拿到别处合成/新增的视频），不整页刷新
await Storage.reloadProject(pid);
// 2. 增量更新 DOM：只插入新出现的视频、移除已删除的，已有 <video> 完全不动（避免全部重新加载）
const added = this._incrementalRenderVideoHistory(pid);
App.showToast(added > 0 ? `已刷新，新增 ${added} 个视频` : '已是最新，无新增视频', 'success');
},

// 增量刷新视频历史：对比最新列表与当前 DOM，仅新增/移除变化的卡片。
// 返回新增数量。若结构不存在（如当前不在视频 tab 或排序为手动）则回退整页渲染。
_incrementalRenderVideoHistory(pid) {
const p = Storage.getProject(pid);
const grid = document.querySelector('.sb-vh-grid');
const sortMode = p.vhSort || 'time';
const sortDir = p.vhSortDir || 'asc';
// 手动排序模式涉及拖拽顺序，且 grid 不存在（空态/未在该 tab）时，直接整页渲染
if (!grid || sortMode === 'custom') {
this.renderVideoHistory(pid);
return 0;
}
const list = Array.isArray(p.storyboardVideos) ? p.storyboardVideos.slice() : [];
this._vhSortList(list, sortMode, sortDir);
const latestIds = list.map(v => String(v.id));
const latestSet = new Set(latestIds);

// 移除 DOM 中已不存在于最新列表的卡片
const existing = new Map();
grid.querySelectorAll('.sb-vh-card').forEach(card => {
const vid = card.getAttribute('data-vid');
if (!latestSet.has(vid)) { card.remove(); }
else { existing.set(vid, card); }
});

const canDrag = (sortMode === 'custom');
let added = 0;
// 按最新顺序重排：已存在的复用原节点（不重建 video），缺失的新建插入
let prev = null;
for (const v of list) {
const vid = String(v.id);
let card = existing.get(vid);
if (!card) {
const tmp = document.createElement('div');
tmp.innerHTML = this._vhCardHtml(v, canDrag).trim();
card = tmp.firstElementChild;
added++;
}
// 按顺序放置到 prev 之后（insertBefore 移动已存在节点不会重置 video 播放状态）
if (prev) {
if (prev.nextElementSibling !== card) grid.insertBefore(card, prev.nextElementSibling);
} else {
if (grid.firstElementChild !== card) grid.insertBefore(card, grid.firstElementChild);
}
prev = card;
}
return added;
},

    delVideoHistory(id) {
        const p = Storage.getProject(this.projectId);
        const list = (p.storyboardVideos || []).filter(v => v.id !== id);
        Storage.updateProject(this.projectId, { storyboardVideos: list });
        App.showToast('已从视频历史移除（未删除原文件）', 'success');
        if (typeof ProjectModule !== 'undefined' && ProjectModule.currentTab === 'videos') {
            this.renderVideoHistory(this.projectId);
        }
    },

    // 标记/取消标记「已看」：标记后本卡片置灰，便于区分哪些已播放
    toggleVideoWatched(id) {
        const p = Storage.getProject(this.projectId);
        const list = (p.storyboardVideos || []).slice();
        const v = list.find(x => x.id === id);
        if (!v) return;
        v.watched = !v.watched;
        Storage.updateProject(this.projectId, { storyboardVideos: list });
        // 只局部更新该卡片 DOM（切换置灰样式 / 按钮文案 / 已看标签），不整页重渲染——
        // 整页 renderVideoHistory 会重建所有 <video>，触发全部视频重新加载，非常慢。
        const card = document.querySelector(`.sb-vh-card[data-vid="${id}"]`);
        if (!card) return;
        card.classList.toggle('is-watched', !!v.watched);
        const btn = card.querySelector('.sb-vh-markbtn');
        if (btn) {
            btn.classList.toggle('on', !!v.watched);
            btn.textContent = v.watched ? '↺ 标记已看' : '✓ 标记已看';
        }
        // 名称行末尾的「已看」小标签：有则按需移除/添加
        const nameEl = card.querySelector('.sb-vh-name');
        if (nameEl) {
            const tagEl = nameEl.querySelector('.sb-vh-tag-watched');
            if (v.watched && !tagEl) {
                const s = document.createElement('span');
                s.className = 'sb-vh-tag sb-vh-tag-watched';
                s.textContent = '已看';
                nameEl.appendChild(document.createTextNode(' '));
                nameEl.appendChild(s);
            } else if (!v.watched && tagEl) {
                tagEl.remove();
            }
        }
    },

    // 重命名：自定义显示名（持久化），同时影响拖出/下载文件名；留空恢复默认命名
    async renameVideoHistory(id) {
        const p = Storage.getProject(this.projectId);
        const list = (p.storyboardVideos || []).slice();
        const v = list.find(x => x.id === id);
        if (!v) return;
        const cur = this._vhDisplayName(v);
        const next = await App.prompt({
            title: '重命名视频',
            message: '自定义该视频的显示名（同时作为拖出/下载的文件名）。留空可恢复默认命名。',
            defaultValue: cur,
            placeholder: cur,
        });
        if (next === null) return;   // 取消
        v.displayName = (next || '').trim();   // 空串 → 恢复默认
        Storage.updateProject(this.projectId, { storyboardVideos: list });
        App.showToast(v.displayName ? '已重命名' : '已恢复默认命名', 'success');
        if (typeof ProjectModule !== 'undefined' && ProjectModule.currentTab === 'videos') {
            this.renderVideoHistory(this.projectId);
        }
    },

    // 点「导入视频」按钮 → 触发文件选择
    pickImportVideo() {
        const inp = document.getElementById('vhImportInput');
        if (inp) inp.click();
    },

    // 文件选择导入
    async onImportVideoInput(ev) {
        const files = Array.from((ev.target && ev.target.files) || []);
        if (ev.target) ev.target.value = '';   // 允许重复选同一文件
        await this._importVideoFiles(files);
    },

    // 拖放导入
    async onImportVideoDrop(ev) {
        ev.preventDefault();
        const zone = document.getElementById('vhDropZone');
        if (zone) zone.classList.remove('drag-over');
        const files = Array.from((ev.dataTransfer && ev.dataTransfer.files) || [])
            .filter(f => /^video\//.test(f.type) || /\.(mp4|webm|mov|mkv|avi|gif)$/i.test(f.name));
        if (!files.length) { App.showToast('请拖入视频文件（mp4/webm/mov/mkv/avi/gif）', 'error'); return; }
        await this._importVideoFiles(files);
    },

    // 把选中的本地视频文件上传到后端落盘一次，记录返回的绝对路径作为索引（不再二次复制）
    async _importVideoFiles(files) {
        if (!files || !files.length) return;
        let ok = 0;
        for (const f of files) {
            try {
                App.showToast(`正在导入「${f.name}」…`, 'info');
                const b64 = await this._fileToB64(f);
                const r = await API.post('/api/import_video', { data: b64, filename: f.name });
                if (!r || !r.success || !r.video_file) throw new Error((r && r.error) || '导入失败');
                this._addImportedVideo({ file: r.video_file, rawName: f.name });
                ok++;
            } catch (e) {
                App.showToast(`导入「${f.name}」失败：${e.message || e}`, 'error');
            }
        }
        if (ok) App.showToast(`已导入 ${ok} 个视频（已自动索引）`, 'success');
        if (typeof ProjectModule !== 'undefined' && ProjectModule.currentTab === 'videos') {
            this.renderVideoHistory(this.projectId);
        }
    },

    // 把 File 读成纯 base64（不含 data: 前缀）
    _fileToB64(file) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => {
                const s = String(fr.result || '');
                resolve(s.includes(',') ? s.split(',', 2)[1] : s);
            };
            fr.onerror = reject;
            fr.readAsDataURL(file);
        });
    },

    // 导入视频入历史：标记 imported=true，默认显示名取原文件名（可重命名）
    _addImportedVideo({ file, rawName }) {
        const p = Storage.getProject(this.projectId);
        const list = Array.isArray(p.storyboardVideos) ? p.storyboardVideos.slice() : [];
        list.push({
            id: Storage._uid(),
            file: file || '',
            rawName: rawName || '',
            frames: 0,
            imported: true,
            groupFrom: 9999, groupTo: 9999,   // 导入项排在合成项之后
            baseName: '导入', seq: list.filter(v => v.imported).length,
            createdAt: Date.now(),
        });
        Storage.updateProject(this.projectId, { storyboardVideos: list });
    },

    // 打开弹窗时恢复：若有进行中的视频任务，继续计时 + 轮询；并补渲染失败横幅
    _resumeVideoTask() {
        this._renderVideoErrBanner();
        const t = this._loadVideoTask();
        if (!t) { this._syncVideoUI(); return; }
        this._startVideoTimer();
        if (this._videoPolling !== t.task_id) this._pollVideoTask(t.task_id);
        this._syncVideoUI();
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