const App = {
    currentPage: 'home',
    currentProjectId: null,
    previousPage: null,
    previousProjectId: null,
    modalLocked: false,

    async init() {
        await Storage.init();
        this.applyTheme();
        this.setupEventListeners();
        if (typeof CharacterModule !== 'undefined' && CharacterModule.initDropUpload) CharacterModule.initDropUpload();
        this.loadFromHash();
        window.addEventListener('hashchange', () => this.loadFromHash());
    },

    loadFromHash() {
        const hash = window.location.hash.replace('#', '');
        if (!hash) {
            this.navigateToHome(false);
            return;
        }
        const parts = hash.split('/');
        if (parts[0] === 'settings') {
            // 设置已改为弹窗，不再作为独立页面。兼容旧的 #settings 链接：
            // 回到首页并自动弹出设置弹窗（不影响主内容浏览）。
            this.navigateToHome(false);
            if (typeof SettingsModule !== 'undefined') SettingsModule.open();
        } else if (parts[0] === 'project' && parts[1]) {
            this.navigateToProject(parts[1], false);
        } else {
            this.navigateToHome(false);
        }
    },

    applyTheme() {
        const settings = Storage.getSettings();
        const html = document.documentElement;
        if (settings.theme === 'light') {
            html.setAttribute('data-theme', 'light');
            document.getElementById('sunIcon').style.display = 'none';
            document.getElementById('moonIcon').style.display = 'block';
        } else {
            html.removeAttribute('data-theme');
            document.getElementById('sunIcon').style.display = 'block';
            document.getElementById('moonIcon').style.display = 'none';
        }
    },

    toggleTheme() {
        const settings = Storage.getSettings();
        const newTheme = settings.theme === 'dark' ? 'light' : 'dark';
        Storage.saveSettings({ theme: newTheme });
        this.applyTheme();
    },

    setupEventListeners() {
        document.getElementById('settingsBtn').addEventListener('click', () => {
            // 设置改为弹窗：打开时不影响当前正在浏览的页面，关闭后仍停留在原页面。
            SettingsModule.open();
        });
        document.getElementById('themeToggle').addEventListener('click', () => {
            this.toggleTheme();
        });
        document.getElementById('modalOverlay').addEventListener('click', (e) => {
            if (this.modalLocked) return;
            if (e.target === document.getElementById('modalOverlay')) {
                this.closeModal();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.modalLocked) return;
                // 通用 modal 在上层时优先关它（如设置内的「全屏编辑」子弹窗）；否则关设置弹窗。
                const genericOpen = document.getElementById('modalOverlay').classList.contains('active');
                const settingsOv = document.getElementById('settingsOverlay');
                if (!genericOpen && settingsOv && settingsOv.classList.contains('active')) {
                    SettingsModule.close();
                    return;
                }
                this.closeModal();
            }
        });
    },

    updateBackBtn() {
        const btn = document.getElementById('backBtn');
        if (this.currentPage === 'home') {
            btn.style.display = 'none';
        } else {
            btn.style.display = 'flex';
        }
    },

    navigateToHome(updateHash) {
        if (updateHash !== false) {
            this.previousPage = this.currentPage;
            this.previousProjectId = this.currentProjectId;
            window.location.hash = '#home';
        }
        this.currentPage = 'home';
        this.currentProjectId = null;
        this.updateBackBtn();
        HomeModule.render();
    },

    navigateToProject(projectId, updateHash) {
        if (updateHash !== false) {
            this.previousPage = this.currentPage;
            this.previousProjectId = this.currentProjectId;
            window.location.hash = '#project/' + projectId;
        }
        this.currentPage = 'project';
        this.currentProjectId = projectId;
        this.updateBackBtn();
        ProjectModule.render(projectId);
    },

    // 设置已改为弹窗，此方法保留兼容：直接打开弹窗，不切换主内容页面。
    navigateToSettings() {
        SettingsModule.open();
    },

    navigateBack() {
        if (this.previousPage === 'project' && this.previousProjectId) {
            this.navigateToProject(this.previousProjectId);
        } else {
            this.navigateToHome();
        }
    },

    closeModal() {
        if (this.modalLocked) return;
        document.getElementById('modalOverlay').classList.remove('active');
        document.getElementById('modalContent').innerHTML = '';
    },

    showToast(message, type) {
        type = type || 'success';
        let toast = document.getElementById('toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'toast';
            document.body.appendChild(toast);
        }
        toast.className = 'toast ' + type + ' active';
        toast.innerHTML = message;
        // Show error toasts longer (5s) so users can read the API error message
        const duration = type === 'error' ? 5000 : 3000;
        setTimeout(() => {
            toast.classList.remove('active');
        }, duration);
    },

    // ===== 音频拖放：把网页内的音频直接拖到外部剪辑软件 / 桌面 =====
    // 浏览器原生能力：在 dragstart 时设置 DownloadURL（mime:filename:url），
    // Chromium 系（Chrome/Edge/IDE WebView）支持将其拖出到操作系统应用。
    // url 需为可直接 GET 的真实地址（Storage.mediaUrl 返回 http URL，符合要求）。
    audioDragHandle(url, filename, label) {
        if (!url) return '';
        const f = (filename || 'audio.wav').replace(/[\\/:*?"<>|]/g, '_');
        const u = String(url);
        const text = label || '拖到剪辑软件';
        return `<span class="audio-drag-handle" draggable="true" title="按住拖拽，可直接拖到剪辑软件或桌面导出该音频"
            ondragstart="App.onAudioDragStart(event, '${u.replace(/'/g, "\\'")}', '${f.replace(/'/g, "\\'")}')">⤓ ${this.esc ? this.esc(text) : text}</span>`;
    },
    // 视频拖放 handle：复用 onAudioDragStart 的 DownloadURL 机制，mime 按扩展名推断（默认 video/mp4）
    videoDragHandle(url, filename, label) {
        if (!url) return '';
        const f = (filename || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_');
        const u = String(url);
        const text = label || '拖到剪辑软件';
        const mime = /\.webm$/i.test(f) ? 'video/webm' : /\.mov$/i.test(f) ? 'video/quicktime' : /\.gif$/i.test(f) ? 'image/gif' : 'video/mp4';
        return `<span class="audio-drag-handle" draggable="true" title="按住拖拽，可直接拖到剪辑软件或桌面导出该视频"
            ondragstart="App.onAudioDragStart(event, '${u.replace(/'/g, "\\'")}', '${f.replace(/'/g, "\\'")}', '${mime}')">⤓ ${this.esc ? this.esc(text) : text}</span>`;
    },
    onAudioDragStart(ev, url, filename, mime) {
        try {
            const dt = ev.dataTransfer;
            if (!dt) return;
            const m = mime || (/\.mp3$/i.test(filename) ? 'audio/mpeg' : /\.flac$/i.test(filename) ? 'audio/flac' : /\.ogg$/i.test(filename) ? 'audio/ogg' : 'audio/wav');
            // 绝对 URL（DownloadURL 要求完整地址）
            let abs = url;
            try { abs = new URL(url, location.href).href; } catch (e) {}
            // 关键：给拖出地址追加 dl=<文件名>，后端据此返回 Content-Disposition: attachment，
            // 这样剪映等剪辑软件接收 Chromium 的 DownloadURL 拖放时才会把它识别为可拖入的文件。
            let dlAbs = abs;
            try {
                const u = new URL(abs);
                u.searchParams.set('dl', filename);
                dlAbs = u.href;
            } catch (e) { /* 非标准 URL 时退回原地址 */ }
            dt.effectAllowed = 'copy';
            // 关键：DownloadURL → 拖出到外部应用时按此下载为文件
            dt.setData('DownloadURL', `${m}:${filename}:${dlAbs}`);
            // 兼容：拖到支持 URL/文本的目标
            dt.setData('text/uri-list', dlAbs);
            dt.setData('text/plain', dlAbs);
        } catch (e) { /* 忽略：不影响页面其它交互 */ }
    },

    // 应用内确认弹窗（替代原生 confirm —— IDE 内嵌 WebView 会禁用原生 alert/confirm）。
    // 返回 Promise<boolean>：点确定 resolve(true)，取消/关闭 resolve(false)。
    confirm(opts) {
        opts = (typeof opts === 'string') ? { message: opts } : (opts || {});
        const title = opts.title || '请确认';
        const message = opts.message || '';
        const okText = opts.okText || '确定';
        const cancelText = opts.cancelText || '取消';
        const danger = !!opts.danger;
        return new Promise(resolve => {
            const overlay = document.getElementById('confirmOverlay') || (() => {
                const o = document.createElement('div');
                o.id = 'confirmOverlay';
                o.className = 'modal-overlay';
                o.innerHTML = '<div class="modal confirm-modal" id="confirmModal"></div>';
                document.body.appendChild(o);
                return o;
            })();
            const box = overlay.querySelector('#confirmModal');
            const msgHtml = String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
            box.innerHTML =
                '<div class="modal-header"><h2 class="modal-title">' + title + '</h2></div>' +
                '<div class="modal-body"><p class="confirm-text">' + msgHtml + '</p></div>' +
                '<div class="modal-footer">' +
                '<button class="btn-secondary" id="confirmCancel">' + cancelText + '</button>' +
                '<button class="' + (danger ? 'btn-danger' : 'btn-primary') + '" id="confirmOk">' + okText + '</button>' +
                '</div>';
            const close = (val) => {
                overlay.classList.remove('active');
                resolve(val);
            };
            box.querySelector('#confirmOk').onclick = () => close(true);
            box.querySelector('#confirmCancel').onclick = () => close(false);
            overlay.onclick = (e) => { if (e.target === overlay) close(false); };
            overlay.classList.add('active');
        });
    },

    // 应用内输入弹窗（替代原生 prompt —— IDE 内嵌 WebView 会禁用原生 prompt）。
    // 返回 Promise<string|null>：点确定 resolve(输入值)，取消/关闭 resolve(null)。
    prompt(opts) {
        opts = (typeof opts === 'string') ? { message: opts } : (opts || {});
        const title = opts.title || '请输入';
        const message = opts.message || '';
        const okText = opts.okText || '确定';
        const cancelText = opts.cancelText || '取消';
        const defVal = opts.defaultValue != null ? String(opts.defaultValue) : '';
        const ph = opts.placeholder || '';
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        return new Promise(resolve => {
            const overlay = document.getElementById('confirmOverlay') || (() => {
                const o = document.createElement('div');
                o.id = 'confirmOverlay';
                o.className = 'modal-overlay';
                o.innerHTML = '<div class="modal confirm-modal" id="confirmModal"></div>';
                document.body.appendChild(o);
                return o;
            })();
            const box = overlay.querySelector('#confirmModal');
            const msgHtml = esc(message).replace(/\n/g, '<br>');
            box.innerHTML =
                '<div class="modal-header"><h2 class="modal-title">' + esc(title) + '</h2></div>' +
                '<div class="modal-body">' +
                (message ? '<p class="confirm-text">' + msgHtml + '</p>' : '') +
                '<input type="text" class="form-input" id="promptInput" value="' + esc(defVal) + '" placeholder="' + esc(ph) + '" style="width:100%;margin-top:.4rem">' +
                '</div>' +
                '<div class="modal-footer">' +
                '<button class="btn-secondary" id="promptCancel">' + esc(cancelText) + '</button>' +
                '<button class="btn-primary" id="promptOk">' + esc(okText) + '</button>' +
                '</div>';
            const input = box.querySelector('#promptInput');
            const close = (val) => { overlay.classList.remove('active'); resolve(val); };
            box.querySelector('#promptOk').onclick = () => close(input.value);
            box.querySelector('#promptCancel').onclick = () => close(null);
            overlay.onclick = (e) => { if (e.target === overlay) close(null); };
            input.onkeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
                else if (e.key === 'Escape') { e.preventDefault(); close(null); }
            };
            overlay.classList.add('active');
            setTimeout(() => { input.focus(); input.select(); }, 30);
        });
    }
};

// ============================================================
// InlineEdit：通用就地编辑组件
// 用法：给任意需要"行内可改+自动保存"的字段加上下属性：
//   <div class="inline-edit" contenteditable="plaintext-only"
//        data-edit="char"           // 路由 key：char / item / sb-group / sb-panel
//        data-id="<id>"             // 主键
//        data-type="props|scenes"   // item 用
//        data-gid="<groupId>"       // sb-* 用
//        data-panel="0..3"          // sb-panel 用
//        data-field="name|appearance|voice|description|globalPrompt|nanoPrompt|local|text|tone|character"
//        data-placeholder="—"       // 空时占位
//   >文本</div>
// - 失焦 / Ctrl+Enter / Esc(还原) 触发保存；未变化不写库。
// - 单行字段（name / text / character / tone）用 data-single="1" 阻止换行。
// 全局事件代理，无需逐节点 bind；renderXxx 重绘后依然生效。
// ============================================================
const InlineEdit = {
    init() {
        document.addEventListener('focusin', e => this._onFocusIn(e));
        document.addEventListener('focusout', e => this._onFocusOut(e));
        document.addEventListener('keydown', e => this._onKeyDown(e));
    },

    _onFocusIn(e) {
        const el = e.target.closest('.inline-edit');
        if (!el || el.dataset.editReady === '1') return;
        // 记录原始值，并把占位文本去掉以便编辑
        el.dataset.original = el.textContent;
        if (el.classList.contains('is-empty')) {
            el.classList.remove('is-empty');
            if (el.textContent === (el.dataset.placeholder || '—')) el.textContent = '';
        }
        el.dataset.editReady = '1';
        el.classList.add('editing');
    },

    _onFocusOut(e) {
        const el = e.target.closest('.inline-edit');
        if (!el || el.dataset.editReady !== '1') return;
        delete el.dataset.editReady;
        el.classList.remove('editing');
        const newVal = (el.textContent || '').replace(/\u00a0/g, ' ').trim();
        const oldVal = (el.dataset.original || '').trim();
        // 单行字段去掉换行
        const single = el.dataset.single === '1';
        const cleaned = single ? newVal.replace(/[\r\n]+/g, ' ') : newVal;
        if (cleaned !== oldVal) {
            const ok = this._save(el, cleaned);
            if (ok) this._flashSaved(el);
            else el.textContent = oldVal;  // 保存失败回滚
        }
        // 恢复占位（保存成功后由调用方刷新；这里只处理空值视觉）
        if (!el.textContent) {
            const ph = el.dataset.placeholder || '—';
            el.textContent = ph;
            el.classList.add('is-empty');
        }
    },

    _onKeyDown(e) {
        const el = e.target.closest('.inline-edit');
        if (!el) return;
        if (e.key === 'Escape') {
            // 还原并失焦
            el.textContent = el.dataset.original || '';
            el.blur();
            e.preventDefault();
        } else if (e.key === 'Enter') {
            // 单行字段：Enter 直接保存；多行字段：仅 Ctrl/Cmd+Enter 保存
            if (el.dataset.single === '1' || e.ctrlKey || e.metaKey) {
                el.blur();
                e.preventDefault();
            }
        }
    },

    _save(el, val) {
        const action = el.dataset.edit;
        const pid = App.currentProjectId;
        if (!pid) return false;
        try {
            if (action === 'char') {
                Storage.updateCharacter(pid, el.dataset.id, { [el.dataset.field]: val });
            } else if (action === 'item') {
                Storage.updateItem(pid, el.dataset.type, el.dataset.id, { [el.dataset.field]: val });
            } else if (action === 'sb-group') {
                const p = Storage.getProject(pid);
                const g = (p.storyboardGroups || []).find(x => x.id === el.dataset.gid);
                if (!g) return false;
                const f = el.dataset.field;
                if (f === 'globalPrompt' || f === 'nanoPrompt') g[f] = val;
                else g[f] = val;
                Storage.updateProject(pid, { storyboardGroups: p.storyboardGroups });
            } else if (action === 'sb-panel') {
                const p = Storage.getProject(pid);
                const g = (p.storyboardGroups || []).find(x => x.id === el.dataset.gid);
                if (!g) return false;
                const idx = parseInt(el.dataset.panel);
                const f = el.dataset.field;
                if (f === 'local') {
                    if (!Array.isArray(g.localPrompts)) g.localPrompts = ['', '', '', ''];
                    g.localPrompts[idx] = val;
                } else if (f === 'shotTransition') {
                    if (!Array.isArray(g.shotTransitions)) g.shotTransitions = ['', '', '', ''];
                    g.shotTransitions[idx] = val;
                } else {
                    // text / tone / character → dialogues[idx]
                    if (!Array.isArray(g.dialogues)) g.dialogues = [];
                    if (!g.dialogues[idx]) g.dialogues[idx] = { panel: idx + 1 };
                    g.dialogues[idx][f] = val;
                }
                Storage.updateProject(pid, { storyboardGroups: p.storyboardGroups });
            } else if (action === 'sb-single') {
                // 单分镜本体字段（如 prompt）
                const p = Storage.getProject(pid);
                const g = (p.storyboardGroups || []).find(x => x.id === el.dataset.gid);
                if (!g) return false;
                g[el.dataset.field] = val;
                Storage.updateProject(pid, { storyboardGroups: p.storyboardGroups });
            } else if (action === 'sb-single-dlg') {
                // 单分镜对话字段（text / tone / character）
                const p = Storage.getProject(pid);
                const g = (p.storyboardGroups || []).find(x => x.id === el.dataset.gid);
                if (!g) return false;
                if (!g.dialogue) g.dialogue = { character: '', text: '', tone: '' };
                g.dialogue[el.dataset.field] = val;
                Storage.updateProject(pid, { storyboardGroups: p.storyboardGroups });
            } else {
                return false;
            }
            return true;
        } catch (err) {
            console.warn('InlineEdit save failed', err);
            return false;
        }
    },

    // 在元素右上角短暂显示 ✓ 已保存
    _flashSaved(el) {
        let tag = el.querySelector('.inline-edit-saved');
        if (!tag) {
            tag = document.createElement('span');
            tag.className = 'inline-edit-saved';
            tag.textContent = '✓ 已保存';
            el.appendChild(tag);
        }
        tag.classList.add('show');
        clearTimeout(tag._t);
        tag._t = setTimeout(() => { tag.classList.remove('show'); }, 1200);
    },

    // 生成器：根据值/占位返回 HTML（统一处理空值视觉）
    field(val, opts) {
        opts = opts || {};
        const ph = opts.placeholder || '—';
        const text = (val == null || val === '') ? ph : String(val);
        const empty = (val == null || val === '');
        const attrs = Object.entries(opts.data || {})
            .map(([k, v]) => `data-${k}="${(v == null ? '' : String(v)).replace(/"/g, '&quot;')}"`).join(' ');
        const ce = opts.single ? 'plaintext-only' : 'plaintext-only';
        const cls = 'inline-edit' + (empty ? ' is-empty' : '') + (opts.className ? ' ' + opts.className : '');
        return `<div class="${cls}" contenteditable="${ce}" spellcheck="false"
            data-placeholder="${ph.replace(/"/g, '&quot;')}"
            ${opts.single ? 'data-single="1"' : ''}
            ${attrs}>${App._escHtml(text)}</div>`;
    },
};

// HTML 转义工具（供 InlineEdit.field 使用）
App._escHtml = function (t) {
    const d = document.createElement('div');
    d.textContent = t == null ? '' : t;
    return d.innerHTML;
};

document.addEventListener('DOMContentLoaded', () => {
    App.init();
    InlineEdit.init();
});
