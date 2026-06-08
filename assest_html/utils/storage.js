const Storage = {
    _data: null,       // { projects: [], settings: {} } — kept in memory for fast access
    _idCounter: 0,
    _ready: null,
    API: 'http://localhost:8765',

    _uid() {
        this._idCounter++;
        return Date.now().toString(36) + '_' + this._idCounter.toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    },

    // Convert a stored media path to a display URL
    mediaUrl(path) {
        if (!path) return '';
        if (path.startsWith('data:')) return path; // legacy base64
        return this.API + '/api/' + path;
    },

    async init() {
        this._ready = this._loadAll();
        await this._ready;
        this._fixDuplicates();
        this._fixMediaSelection();
    },

    async ready() {
        if (this._ready) await this._ready;
    },

    // ==================== Loading ====================

    async _loadAll() {
        // ===== Settings: SERVER (SQLite) is the single source of truth =====
        // localStorage is only an offline fallback cache, never overrides the server.
        let settings = null;
        let source = 'default';

        // 1. Server first (authoritative). A reload always reflects the database.
        try {
            const r = await (await fetch(this.API + '/api/settings/load', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            })).json();
            if (r.success && r.settings && Object.keys(r.settings).length > 0) {
                settings = r.settings;
                source = 'server';
                // Refresh offline cache to match server
                try { localStorage.setItem('assest_settings', JSON.stringify(settings)); } catch (e) {}
            }
        } catch (e) {
            console.warn('Storage: 服务器设置加载失败，尝试离线缓存', e.message);
        }

        // 2. Offline fallback: use localStorage only when the server is unreachable
        if (!settings || Object.keys(settings).length === 0) {
            const cached = localStorage.getItem('assest_settings');
            if (cached) {
                try { settings = JSON.parse(cached); source = 'localStorage(offline)'; }
                catch (e) { localStorage.removeItem('assest_settings'); }
            }
        }

        if (!settings || Object.keys(settings).length === 0) {
            settings = {};
        }
        console.log('Storage: 设置已加载 (来源:', source, ')');

        // ===== Projects: localStorage first, server second =====
        let projects = [];
        let serverOk = false;

        // 1. Try server for projects (authoritative source)
        try {
            const r = await (await fetch(this.API + '/api/projects/list', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            })).json();
            if (r.success && r.projects) {
                serverOk = true;
                for (const entry of r.projects) {
                    try {
                        const pr = await (await fetch(this.API + '/api/projects/load', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: entry.id })
                        })).json();
                        if (pr.success && pr.project) {
                            projects.push(pr.project);
                            // Cache to localStorage
                            try { localStorage.setItem('assest_project_' + entry.id, JSON.stringify(pr.project)); } catch(e) {}
                        }
                    } catch (e) {
                        console.warn('Storage: 加载项目失败 ' + entry.id, e);
                    }
                }
                // Cache project index
                try { localStorage.setItem('assest_projects_index', JSON.stringify(r.projects.map(p => p.id))); } catch(e) {}
                console.log('Storage: 项目已从服务器加载 (' + projects.length + '个)');
            }
        } catch (e) {
            console.warn('Storage: 服务器项目加载失败，使用本地缓存', e.message);
        }

        // 2. If server failed, load from localStorage
        if (!serverOk) {
            const cachedIdx = localStorage.getItem('assest_projects_index');
            if (cachedIdx) {
                try {
                    const ids = JSON.parse(cachedIdx);
                    for (const id of ids) {
                        const cached = localStorage.getItem('assest_project_' + id);
                        if (cached) {
                            try { projects.push(JSON.parse(cached)); } catch(e) {}
                        }
                    }
                    console.log('Storage: 项目已从本地缓存加载 (' + projects.length + '个)');
                } catch(e) {}
            }
        }

        this._data = { projects, settings };
        if (!serverOk && projects.length === 0) {
            App.showToast && App.showToast('⚠ 无法连接服务器，如果这是首次使用请先启动后端', 'warning');
        }
    },

    // ==================== Settings ====================

    getDefaultSettings() {
        return {
            llmApiKey: '', llmApiUrl: '',
            globalPrompt: `你是一名专业的影视分镜与美术设定师。请仔细通读以下剧本，提取用于后续「图像/音频生成」的核心设定信息。

【提取对象与标准】
1. 人物 characters：剧本中出现的、有名字或明确身份的角色。需为每个角色补全可用于绘图的外貌设定。
   - name：角色姓名或称谓（如"老人""神秘女子"）。同一角色只出现一次，合并不同称呼。
   - appearance：外貌描述，尽量具体（性别、年龄段、发型发色、面部特征、体型、服装风格、标志性配饰等）。剧本未明说的可基于人物身份与情节做合理补充，便于绘图。
   - voice：音色/说话风格描述（如"低沉沙哑的中年男声""清亮活泼的少女音"）。剧本无线索时根据人物性别、年龄、性格推断。

2. 道具 props：**只提取对剧情有实际意义的"关键道具"**，严格控制数量，宁缺毋滥。
   - 必须满足以下至少一条才提取：① 推动剧情或被反复使用；② 具有象征意义或独特外观；③ 与角色身份强绑定的标志物。
   - **不要提取**：环境中的普通背景物（桌椅、杯子、门窗、树木、路灯等）、一次性提及且无关紧要的物品、可被场景描述涵盖的陈设。
   - 数量建议：通常不超过 8 个；若剧本确实简单，可以为 0~3 个。
   - name：道具名称；description：外观与作用描述。

3. 场景 scenes：剧本中发生事件的不同地点/环境。相似或同一地点合并为一个场景。
   - name：场景名称（如"废弃工厂内部""黄昏的海边"）。
   - description：环境氛围、时间、光线、布景等可用于绘图的描述。

【输出要求（必须严格遵守，只输出 JSON，不要任何解释、不要 markdown 代码块）】
{"characters":[{"name":"","appearance":"","voice":""}],"props":[{"name":"","description":""}],"scenes":[{"name":"","description":""}]}

注意：所有字段使用中文；去重；道具务必精简；没有内容的数组返回 []。`,
            storyboardPrompt: `你是好莱坞级别的电影分镜导演 + LTX 2.3 视频提示词工程师（中文），兼具专业摄影指导（DP）的镜头语言素养。根据给定的【剧本】+【已有人物/道具/场景设定】，自动拆分分镜，按每 4 个 Shot 为一个四宫格分组，输出可直接用于「四宫格图像生成 + 配音 + 图生视频」的 JSON。**不需要计算任何时长/帧数，时长由用户在时间轴上手动调整。**

# 导演核心要求（贯穿全程）
- 像真正的导演那样思考每一个镜头：用**电影级、专业的镜头语言**描述每个 Shot，明确景别、机位、运镜、构图、光影、人物调度。
- 描述要**具体、丰富、有画面感**：不要只写"人物说话"，要写清楚他在画面哪个位置、什么景别、镜头怎么运动、身体怎么动、表情怎么变、手势细节、环境氛围。
- 善用专业术语：景别（远景/全景/中景/近景/特写/大特写）、机位（平视/俯拍/仰拍/过肩/POV主观视角）、运镜（推镜push in/拉镜pull out/横摇pan/跟拍tracking/手持呼吸感/缓慢变焦/环绕arc）、构图（三分法/中心构图/前景遮挡/景深虚化）。

# 一、剧本拆分为 Shot 序列（宁细不粗）
核心：一个 Shot 只承载「一个动作 + 一个情绪 + 最多一句台词」。按以下优先级切分：
1. 台词归属（最高）：每句独立台词 + 其前后反应 = 一个 Shot；不同人说的话 = 不同 Shot。
2. 动作转折：肢体状态明显变化（坐→站、手从键盘到手机）= 新 Shot。
3. 情绪转折：表情/情绪显著转变 = 新 Shot。
4. 叙事节奏：新道具出现、焦点转移、信息揭示 = 新 Shot。
5. 场景/时间变化 = 新 Shot。
判断：若一个 Shot 描述里出现"然后/接着/随后"，说明承载了多动作，必须再拆。

# 二、四宫格分组
将 Shot 按每 4 个一组（idx 从 1 递增），每组恰好 4 个 Shot。
- 分组优先级：叙事弧完整 > 场景/光线一致 > 角色一致。
- 不足 4 个时用「氛围补位」Shot 补满（无台词，延续前一 Shot 的景别与场景氛围）。
- 每组 4 个面板应有内在叙事逻辑（铺垫→发展→转折→反应）。

# 三、角色提取（person，最高优先级先行）
从剧本提取所有出场角色，结合已给的人物设定，编号「角色N」（首次出场顺序，主角优先）。
若已有人物设定中已包含该角色，直接复用其外貌描述，不要另行推测。

# 四、台词识别与人物映射（关键，不可跳过）
逐段标记台词归属：被引号包裹、或"说道/低语/喊道/呢喃"等动词后的内容、明确的旁白/画外音 = 台词。
为每个有台词的 Shot 记录：说话人角色名、台词中文原文、语气（如 语气得意/愤怒/委屈/平静/紧张/机械冰冷）。
台词原文保持中文，**严禁翻译成英文**。

# 五、四宫格 NanoBanana 提示词（nano_banana_prompt）
开头必须按**固定顺序**声明所有将随提示词一起送入的参考图，前端会严格按这个顺序拼接图像：
  1. 先按"本组台词首次出现顺序"列出涉及的所有人物："@图1是[角色1名]、@图2是[角色2名]…"
  2. 紧接按"本组实际出现的道具"顺序追加："@图N是道具:[道具名]…"（**即使道具只出现在某一个面板里也要列**）
  3. 最后追加本组主场景："@图N是场景:[场景名]"（每组至少 1 个场景图）
示例："@图1是周明、@图2是李静、@图3是道具:旧手机、@图4是场景:废弃工厂内部。"
- @图N 索引只在本组内部递增，从 1 开始；本组没出现的人物/道具不要列。
- 提示词正文里**只能用角色名/道具名/场景名引用**，不要描述其外观（外观完全由 @图N 提供）。
- 在你写的"ref_assets"字段（见输出格式）里也必须列出与 @图N 一一对应的清单，方便前端校验。
运镜模式三选一（必须与各 Shot 的 local 描述一致）：
- 渐进式运镜：4 个 Shot 属同一连续动作/情绪流时，用推镜/拉远/摇镜等连贯运镜，保持背景光源角色位置自然过渡。
- 硬切转场：存在说话人切换/场景变化/光线突变/焦点转移时，每个面板独立构图、允许硬切。
- 混合运镜：部分连续部分切换时，明确声明各段策略。
模板结构：@人物声明 + 关键规则(含运镜策略) + 风格 + 场景描述 + 逐面板运镜与动作(面板1左上/2右上/3左下/4右下，各标景别+运镜) + 负面要求 + 「每个面板16:9，2x2网格排列」。
视觉风格默认「电影级真实感，自然光照，真人演员」，用户另有指定则用用户值。

# 六、global_prompt 与 local_prompts（核心，决定成片质量）
- global_prompt：单段连贯中文，融合该组 4 个 Shot 的整体视觉描述、场景基底、统一光源与风格（涉及幻想生物须含完整形态描述并在每段重复）。

- local_prompts：返回长度为 4 的数组，每项对应一个 Shot（面板），是**一整段连贯、丰富的中文画面描述**（建议 30~60 字，信息量要足）。每项必须依次包含以下 7 个要素，缺一不可：
  ① **镜头语言（开头写）**：景别 + 机位 + 运镜，如「中景，平视，镜头缓慢推近」「近景，过肩视角，固定机位」「大特写，微俯拍，手持呼吸感」。
  ② **说话人 + 画面位置**：直接用角色名 + 在画面中的位置，如「周明在画面左侧」「李静在画面中央前景」。位置词：画面左侧/右侧/中央/前景/后景。
  ③ **语气**：如 语气得意/愤怒/委屈/平静/紧张/惊讶/机械冰冷，须与台词情绪一致。
  ④ **主体动作**：人物在做什么，具体到肢体（如「双手快速敲击键盘」「拿起手机滑动屏幕」「猛地起身后退半步」）。动作阶段 ≤3。
  ⑤ **面部表情 + 手势细节**：如「眉头紧锁、嘴角下压」「右手攥拳、指节发白」。
  ⑥ **环境/光影细节**：呼应场景，如「冷白日光从左侧窗户斜射」「霓虹光在桌面投下蓝紫色斑」。同一 Shot 只用一种主光源/主色调。
  ⑦ **台词处理（见下方铁律）**。

  【台词处理铁律 — 必看，避免占位符错误】
  - 有台词的 Shot：把**剧本里真实的台词中文原文**用**英文单引号 '...'（ASCII 半角 U+0027）** 直接包裹后嵌入描述。
    ⚠ 英文单引号只是台词的「定界符」，里面必须填**真实台词文字**。
    ✅ 正确：周明在画面左侧，语气得意，停下打字伸懒腰，轻声说 '终于！今天的报表又被我搞定了！'，面容生动、嘴唇微启。
    ❌ 严禁：出现 'xxxxxx'、'台词'、'……' 等占位符或空内容 —— 这是错误，单引号内必须是剧本真实台词。
    ❌ 严禁：把台词翻译成英文；严禁用中文引号 ""''或英文双引号 " 包裹台词。
    说话动词用中文：低语/呢喃/轻声说/惊呼/问道/叹道/坚定地说/旁白/画外音。
  - 无台词的 Shot：末尾显式标注 无台词 / 静默时刻 / 仅环境音。
  - **多人同框**：必须写明谁在说话、谁不说话；不说话的角色标注「[角色名]在画面[位置]静默观看，不张嘴」，防止对口型驱动错人。
  - **画外音**（说话人不在画面里）：写「[角色名]以画外音说 '真实台词'，画面中仅[在场角色/场景]，无人张嘴说话」。严禁让画面内角色替画外音对口型。

  【收尾】每个 local_prompt **末尾必须加「无字幕」三个字**（画面不渲染任何字幕/字母/文字水印）。

- shot_transitions：返回长度为 4 的数组，每项是「该 Shot 到下一个 Shot 的转场 / 镜头语言连贯性描述」（中文单行，用专业运镜词，如：镜头由中景缓慢推近至特写、人物转身向右带出下一场景、光线渐暗淡入下一镜、快速横摇切到对话另一方…）。**每项末尾也必须加「无字幕」**。第 4 项（最后一个面板）可留空字符串。

# 七、输出格式（必须是合法 JSON，可被 JSON.parse 解析；用 \`\`\`json 包裹；JSON 外无任何解释）
{
  "person": { "角色1": { "人物": "角色名", "描述": "外貌描述（复用已有设定或合理补全）" } },
  "分镜": {
    "1": {
      "global_prompt": "该组整体视觉描述、场景基底与统一光源（中文单行）",
      "local_prompts": ["中景，平视，镜头缓慢推近；周明在画面左侧，语气得意，停下打字伸懒腰，眉飞色舞、右手握拳轻挥，冷白日光从左侧窗户斜射，轻声说 '终于搞定了！'，嘴唇微启、面容生动，无字幕", "近景，过肩视角，固定机位；李静在画面中央，语气惊讶，猛地抬头瞪大双眼、双手撑桌起身，无台词、静默时刻，无字幕", "面板3描述（含完整7要素）…，无字幕", "面板4描述…，无字幕"],
      "shot_transitions": ["镜头由中景缓慢推近至近景，自然过渡，无字幕", "快速横摇切到对话另一方，无字幕", "光线渐暗淡入下一镜，无字幕", ""],
      "nano_banana_prompt": "完整四宫格提示词（中文单行，含@图N声明）",
      "ref_assets": [
        { "idx": 1, "type": "character", "name": "角色1名" },
        { "idx": 2, "type": "prop", "name": "道具名" },
        { "idx": 3, "type": "scene", "name": "场景名" }
      ],
      "dialogues": [
        { "panel": 1, "character": "角色名或空", "text": "台词中文原文或空", "tone": "语气或空" },
        { "panel": 2, "character": "", "text": "", "tone": "" },
        { "panel": 3, "character": "", "text": "", "tone": "" },
        { "panel": 4, "character": "", "text": "", "tone": "" }
      ],
      "negative_prompt": "英文负面词：worst quality, blurry, distorted face, deformed, extra fingers, bad anatomy, text overlay, watermark, multiple panels, split screen, picture-in-picture, frame within frame。涉及幻想生物追加其现实形态反义词。",
      "transition": "本组结束到下一组的转场建议：cut(硬切) / smooth(平滑过渡) / fade(淡入淡出)"
    }
  }
}

规则：所有字符串单行无换行；台词用英文单引号 '...' 包裹**真实中文台词原文**（严禁 'xxxxxx'/'台词' 等占位符，严禁空内容，严禁翻译成英文）；严禁中文引号；local_prompts 固定 4 项，每项须含完整 7 要素（镜头语言+说话人位置+语气+动作+表情手势+环境光影+台词处理）、描述丰富具体（30~60字）、末尾带「无字幕」；shot_transitions 固定 4 项（最后一项可空，其余末尾带「无字幕」）；dialogues 固定 4 项（无台词的面板字段留空）；幻想生物形态描述完整。`,
            voiceSettings: { textTemplate: "我是{name}，这是我的音色，很高兴认识你" },
            imageApiGroups: [
                {
                    id: 'default',
                    name: '默认分组',
                    url: 'https://token.ithinkai.cn/v1',
                    apiKey: 'sk-xr80G3dlDh4RebnKM6ge7fxbRK2Ittg1seJH7BAULwyOYk6l',
                    models: ['dall-e-3', 'gpt-image-2']
                }
            ],
            imageDefaults: {
                activeGroupId: 'default',
                quality: 'auto',
                size: 'auto',
                model: 'dall-e-3'
            },
            theme: 'light'
        };
    },

    getSettings() {
        const raw = (this._data && this._data.settings) ? this._data.settings : {};
        const defs = this.getDefaultSettings();
        return { ...defs, ...raw };
    },

    saveSettings(s) {
        const current = this.getSettings();
        const merged = { ...current, ...s, _savedAt: Date.now() };
        if (!this._data) this._data = { projects: [], settings: {} };
        this._data.settings = merged;

        // 1. Save to localStorage (instant, always works)
        try { localStorage.setItem('assest_settings', JSON.stringify(merged)); } catch (e) {
            console.warn('Storage: localStorage 保存失败', e);
        }

        // 2. Save to server (with retry)
        const doSave = () => fetch(this.API + '/api/settings/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(merged)
        }).then(r => r.json()).then(d => {
            if (d.success) console.log('Storage: 设置已保存到数据库');
            else { console.warn('Storage: 数据库保存失败，3秒后重试', d.error); setTimeout(doSave, 3000); }
        }).catch(e => { console.warn('Storage: 数据库保存失败，3秒后重试', e.message); setTimeout(doSave, 3000); });
        doSave();
    },

    // ==================== Projects ====================

    getProjects() {
        if (!this._data) return [];
        return this._data.projects || [];
    },

    getProject(id) {
        return this.getProjects().find(p => p.id === id);
    },

    createProject(name) {
        const ps = this.getProjects();
        const np = {
            id: this._uid(),
            name,
            displayName: name,
            createdAt: Date.now(),
            script: '',
            characters: [],
            props: [],
            scenes: [],
            storyboards: [],
            mediaLibrary: [],
            prompt: ''
        };
        ps.push(np);
        this._saveProject(np);
        return np;
    },

    updateProject(id, u) {
        const ps = this.getProjects();
        const idx = ps.findIndex(p => p.id === id);
        if (idx !== -1) {
            ps[idx] = { ...ps[idx], ...u };
            this._saveProject(ps[idx]);
            return ps[idx];
        }
        return null;
    },

    deleteProject(id) {
        const ps = this.getProjects().filter(p => p.id !== id);
        this._data.projects = ps;
        // Clean localStorage
        try {
            localStorage.removeItem('assest_project_' + id);
            localStorage.setItem('assest_projects_index', JSON.stringify(ps.map(p => p.id)));
        } catch(e) {}
        // Delete from server
        fetch(this.API + '/api/projects/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        }).catch(e => console.warn('Storage: 删除项目失败', e));
    },

    _cacheProject(proj) {
        try {
            const json = JSON.stringify(proj);
            // Skip if project is too large for localStorage (>3MB)
            if (json.length > 3 * 1024 * 1024) {
                console.warn('Storage: 项目过大(' + (json.length/1024/1024).toFixed(1) + 'MB)，跳过localStorage缓存');
                return;
            }
            localStorage.setItem('assest_project_' + proj.id, json);
            const ids = this.getProjects().map(p => p.id);
            localStorage.setItem('assest_projects_index', JSON.stringify(ids));
        } catch(e) {
            console.warn('Storage: localStorage 缓存失败，可能空间不足', e.message);
            // Try to recover: clear old project caches
            try {
                const keys = Object.keys(localStorage).filter(k => k.startsWith('assest_project_'));
                keys.forEach(k => localStorage.removeItem(k));
            } catch(ex) {}
        }
    },

    async _saveProject(proj) {
        // 1. Cache to localStorage immediately
        this._cacheProject(proj);
        // 2. Save to server (fire-and-forget)
        fetch(this.API + '/api/projects/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(proj)
        }).catch(e => console.warn('Storage: 保存项目到服务器失败', e.message));
    },

    // ==================== Item CRUD ====================

    _projectKey(type) {
        return type === 'characters' ? 'characters' :
               (type === 'props' ? 'props' :
               (type === 'scenes' ? 'scenes' : 'storyboards'));
    },

    addItem(pid, type, item) {
        const p = this.getProject(pid);
        if (!p) return null;
        const ni = {
            id: this._uid(),
            name: item.name || '',
            description: item.description || item.appearance || '',
            voice: item.voice || '',
            source: item.source || 'manual',
            ttsText: item.ttsText || '',
            selectedImage: null,
            selectedAudio: null
        };
        const key = this._projectKey(type);
        if (!p[key]) p[key] = [];
        p[key].push(ni);
        this._saveProject(p);
        return ni;
    },

    addCharacter(pid, c) { return this.addItem(pid, 'characters', c); },

    updateItem(pid, type, iid, u) {
        const p = this.getProject(pid);
        if (!p) return null;
        const key = this._projectKey(type);
        const items = p[key] || [];
        const idx = items.findIndex(c => c.id === iid);
        if (idx !== -1) {
            items[idx] = { ...items[idx], ...u };
            this._saveProject(p);
            return items[idx];
        }
        return null;
    },

    updateCharacter(pid, cid, u) { return this.updateItem(pid, 'characters', cid, u); },

    deleteItem(pid, type, iid) {
        const p = this.getProject(pid);
        if (!p) return;
        const key = this._projectKey(type);
        p[key] = (p[key] || []).filter(c => c.id !== iid);
        this._saveProject(p);
    },

    deleteCharacter(pid, cid) { this.deleteItem(pid, 'characters', cid); },

    // ==================== Media Library (central, numeric IDs) ====================

    // Ensure mediaLibrary exists on project
    _ensureMediaLib(p) {
        if (!p.mediaLibrary) p.mediaLibrary = [];
        return p.mediaLibrary;
    },

    // Get next available numeric media ID
    _nextMediaId(p) {
        const lib = this._ensureMediaLib(p);
        if (lib.length === 0) return 0;
        return Math.max(...lib.map(m => m.id)) + 1;
    },

    // Get all media for a specific item (character/prop/scene/storyboard)
    getMediaForItem(pid, ownerType, ownerId) {
        const p = this.getProject(pid);
        if (!p || !p.mediaLibrary) return [];
        return p.mediaLibrary.filter(m => m.ownerType === ownerType && m.ownerId === ownerId);
    },

    // Get a single media entry by numeric ID
    getMediaById(pid, mediaId) {
        const p = this.getProject(pid);
        if (!p || !p.mediaLibrary) return null;
        const mid = parseInt(mediaId);
        return p.mediaLibrary.find(m => m.id === mid) || null;
    },

    // 安全获取某条目「当前选中的图片/音频」：必须属于该条目，否则返回 null（防止脏数据串图）
    getSelectedMedia(pid, ownerType, item, mediaKind) {
        if (!item) return null;
        const selId = mediaKind === 'audio' ? item.selectedAudio : item.selectedImage;
        if (selId == null) return null;
        const p = this.getProject(pid);
        if (!p || !p.mediaLibrary) return null;
        const mid = parseInt(selId);
        return p.mediaLibrary.find(m =>
            m.id === mid && m.type === mediaKind && m.ownerType === ownerType && m.ownerId === item.id
        ) || null;
    },

    // Add media (image or audio) to the library
    async _addMedia(pid, mediaType, ownerType, ownerId, dataUrl, mime, dims) {
        const p = this.getProject(pid);
        if (!p) return null;
        const lib = this._ensureMediaLib(p);

        let mediaPath = dataUrl;
        if (dataUrl && dataUrl.startsWith('data:')) {
            try {
                const r = await (await fetch(this.API + '/api/media/save', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ project_id: pid, type: mediaType === 'audio' ? 'audio' : 'images', data: dataUrl })
                })).json();
                if (r.success && r.path) mediaPath = r.path;
            } catch (e) {
                console.warn('Storage: 保存媒体到服务器失败，使用base64', e);
            }
        }

        const entry = {
            id: this._nextMediaId(p),
            type: mediaType,
            ownerType: ownerType,
            ownerId: ownerId,
            data: mediaPath,
            mime: mime || (mediaType === 'audio' ? 'audio/wav' : 'image/png'),
            width: (dims && dims.w) || 0,
            height: (dims && dims.h) || 0,
            createdAt: Date.now()
        };
        lib.push(entry);

        // Set as selected for the owner
        const key = this._projectKey(ownerType);
        const item = (p[key] || []).find(c => c.id === ownerId);
        if (item) {
            if (mediaType === 'image') item.selectedImage = entry.id;
            else item.selectedAudio = entry.id;
        }

        this._saveProject(p);
        return entry;
    },

    addCharacterImage(pid, cid, d, dims) { return this._addMedia(pid, 'image', 'characters', cid, d, null, dims); },
    addCharacterAudio(pid, cid, d, mime) { return this._addMedia(pid, 'audio', 'characters', cid, d, mime); },

    // Alias for props/scenes/storyboards (used by existing code)
    async addItemImage(pid, type, iid, imgData, dims) { return this._addMedia(pid, 'image', type, iid, imgData, null, dims); },
    async addItemAudio(pid, type, iid, audioData, mime) { return this._addMedia(pid, 'audio', type, iid, audioData, mime); },

    // Remove media from library
    deleteMediaItem(pid, mediaId) {
        const p = this.getProject(pid);
        if (!p || !p.mediaLibrary) return;
        const mid = parseInt(mediaId);
        const entry = p.mediaLibrary.find(m => m.id === mid);
        if (!entry) return;
        // Clear selection if this was the selected media
        const key = this._projectKey(entry.ownerType);
        const item = (p[key] || []).find(c => c.id === entry.ownerId);
        if (item) {
            if (entry.type === 'image' && item.selectedImage === mid) {
                const others = p.mediaLibrary.filter(m => m.type === 'image' && m.ownerId === entry.ownerId && m.id !== mid);
                item.selectedImage = others.length > 0 ? others[others.length - 1].id : null;
            }
            if (entry.type === 'audio' && item.selectedAudio === mid) {
                const others = p.mediaLibrary.filter(m => m.type === 'audio' && m.ownerId === entry.ownerId && m.id !== mid);
                item.selectedAudio = others.length > 0 ? others[others.length - 1].id : null;
            }
        }
        p.mediaLibrary = p.mediaLibrary.filter(m => m.id !== mid);
        this._saveProject(p);
        // Also delete from server (SQLite BLOB + filesystem)
        if (entry.data && !entry.data.startsWith('data:')) {
            fetch(this.API + '/api/media/delete', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: entry.data })
            }).catch(e => console.warn('Storage: 删除媒体文件失败', e));
        }
    },

    // Set selected image/audio for an item
    setItemSelectedImage(pid, type, iid, mediaId) {
        const p = this.getProject(pid);
        if (!p) return;
        const key = this._projectKey(type);
        const item = (p[key] || []).find(c => c.id === iid);
        if (item) { item.selectedImage = mediaId !== null ? parseInt(mediaId) : null; this._saveProject(p); }
    },
    setItemSelectedAudio(pid, type, iid, mediaId) {
        const p = this.getProject(pid);
        if (!p) return;
        const key = this._projectKey(type);
        const item = (p[key] || []).find(c => c.id === iid);
        if (item) { item.selectedAudio = mediaId !== null ? parseInt(mediaId) : null; this._saveProject(p); }
    },

    // Legacy aliases for backward compat
    deleteCharacterImage(pid, cid, iid) { this.deleteMediaItem(pid, iid); },
    deleteItemImage(pid, type, iid, imgId) { this.deleteMediaItem(pid, imgId); },
    setCharacterCurrentImage(pid, cid, iid) { this.setItemSelectedImage(pid, 'characters', cid, iid); },
    setItemCurrentImage(pid, type, iid, imgId) { this.setItemSelectedImage(pid, type, iid, imgId); },

    // ==================== Storyboard ====================

    addStoryboardItem(pid, item) {
        const p = this.getProject(pid);
        if (!p) return null;
        if (!p.storyboards) p.storyboards = [];
        const shots = p.storyboards;
        const maxShot = shots.reduce((m, s) => Math.max(m, s.shotNumber || 0), 0);
        const ni = {
            id: this._uid(),
            shotNumber: maxShot + 1,
            shotName: item.shotName || `镜头 ${maxShot + 1}`,
            sceneRef: item.sceneRef || '',
            sceneId: item.sceneId || '',
            description: item.description || '',
            characters: item.characters || [],
            dialogue: item.dialogue || '',
            camera: item.camera || '',
            duration: item.duration || 0,
            imagePrompt: item.imagePrompt || '',
            selectedImage: null,
            selectedAudio: null,
            createdAt: Date.now()
        };
        shots.push(ni);
        this._saveProject(p);
        return ni;
    },

    updateStoryboardItem(pid, iid, u) { return this.updateItem(pid, 'storyboards', iid, u); },
    deleteStoryboardItem(pid, iid) { this.deleteItem(pid, 'storyboards', iid); },

    // ==================== Helpers ====================

    _fixDuplicates() {
        const ps = this.getProjects();
        let changed = false;
        for (const p of ps) {
            for (const key of ['characters', 'props', 'scenes', 'storyboards']) {
                const items = p[key] || [];
                const seen = new Map();
                const toFix = [];
                for (const item of items) {
                    if (seen.has(item.id)) { toFix.push(item); }
                    else { seen.set(item.id, true); }
                }
                for (const item of toFix) {
                    item.id = this._uid();
                    changed = true;
                }
            }
        }
        if (changed) {
            for (const p of ps) this._saveProject(p);
        }
    },

    // 自愈：修正 item 的 selectedImage/selectedAudio，使其只指向「属于自己且存在」的媒体。
    // 解决历史脏数据中 selectedImage 指向他人或已删除媒体，导致缩略图与历史不一致的问题。
    _fixMediaSelection() {
        const ps = this.getProjects();
        let changed = false;
        for (const p of ps) {
            const lib = p.mediaLibrary || [];
            if (!lib.length) {
                // 没有任何媒体，但 item 上残留了选择 -> 清空
                for (const key of ['characters', 'props', 'scenes', 'storyboards']) {
                    for (const it of (p[key] || [])) {
                        if (it.selectedImage != null) { it.selectedImage = null; changed = true; }
                        if (it.selectedAudio != null) { it.selectedAudio = null; changed = true; }
                    }
                }
                continue;
            }
            for (const key of ['characters', 'props', 'scenes', 'storyboards']) {
                for (const it of (p[key] || [])) {
                    const ownImages = lib.filter(m => m.type === 'image' && m.ownerType === key && m.ownerId === it.id);
                    const ownAudios = lib.filter(m => m.type === 'audio' && m.ownerType === key && m.ownerId === it.id);
                    // 修正图片选择
                    const imgOk = it.selectedImage != null && ownImages.some(m => m.id === it.selectedImage);
                    if (!imgOk) {
                        const next = ownImages.length ? ownImages[ownImages.length - 1].id : null;
                        if (it.selectedImage !== next) { it.selectedImage = next; changed = true; }
                    }
                    // 修正音频选择
                    const audOk = it.selectedAudio != null && ownAudios.some(m => m.id === it.selectedAudio);
                    if (!audOk) {
                        const next = ownAudios.length ? ownAudios[ownAudios.length - 1].id : null;
                        if (it.selectedAudio !== next) { it.selectedAudio = next; changed = true; }
                    }
                }
            }
        }
        if (changed) {
            for (const p of ps) this._saveProject(p);
            console.log('Storage: 已修正媒体选择关联（清理脏数据）');
        }
    }
};
