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
            this.navigateToSettings(false);
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
            this.navigateToSettings(true);
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

    navigateToSettings(updateHash) {
        if (updateHash !== false) {
            this.previousPage = this.currentPage;
            this.previousProjectId = this.currentProjectId;
            window.location.hash = '#settings';
        }
        this.currentPage = 'settings';
        this.updateBackBtn();
        SettingsModule.render();
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
