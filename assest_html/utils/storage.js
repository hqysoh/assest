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
            storyboardPrompt: `你是电影分镜导演 + 视频提示词工程师，兼具摄影指导（DP）镜头语言素养。根据【剧本】+【已有人物/道具/场景设定】，自动拆分分镜，每 4 个 Shot 为一个四宫格分组，输出可直接用于「四宫格图像生成 + 配音 + 图生视频」的 JSON。**不计算时长/帧数（由用户在时间轴手动调）。**

**视觉风格：{{风格}}**（贯穿全片所有 Shot 与四宫格，统一执行；若为空则按剧本氛围自定）。
**输出语言：{{语言}}**。
- \`中文\`：local_prompts 全部用中文（动作/运镜/光照/声音/对白都中文）。
  - \`英文\`：local_prompts 用英文，**仅对白原文保留中文并用英文单引号包裹**，其余一律英文。

# 一、拆分 Shot（宁细不粗）
一个 Shot 只承载「一个动作 + 一个情绪 + 最多一句台词」。切分优先级：① 每句独立台词+前后反应=一个 Shot，不同人说话=不同 Shot；② 肢体/情绪明显转变=新 Shot；③ 新道具/焦点转移/场景时间变化=新 Shot。出现「然后/接着/随后」说明多动作，必须再拆。

# 二、四宫格分组
每 4 个 Shot 一组（idx 从 1 递增），每组恰好 4 个，遵循叙事弧（铺垫→发展→转折→反应）。不足 4 个用「氛围补位」Shot（无台词，延续前一 Shot 氛围）补满。

# 三、角色与台词
- 提取所有出场角色，编号「角色N」（首次出场序，主角优先）；已有设定直接复用外貌，不另行推测。
- 标记台词归属（引号内、说道/低语/喊道后、旁白/画外音）。台词原文保持中文，**严禁翻译**。

# 四、配音情绪（写进 dialogues[].tone，中文）
配音用 IndexTTS-2，八个情感维度（强度从无到很强）：高兴、愤怒、悲伤、恐惧、厌恶、低落、惊讶、平静。
为每句台词在 tone 里用**简短中文**点出主导情绪+程度，作为合成时手动调节的参考，例如：「惊讶 较强、开心 轻微」「愤怒 很强、厌恶 中等」「平静 中等」「悲伤 较强、低落 中等」。
- 一句通常 1~3 个主导情绪，宁少勿杂；平淡就写「平静 中等」。
- ⚠ 情绪只写在 tone；text 只放纯净中文台词（不带任何标签/注释）；画面提示词里严禁出现情绪词。

# 五、画面描述铁律（local_prompts + 四宫格通用）
**只描述看得见的动作、表情、光影、构图。**
- 禁抽象/心理/隐喻（如「无梦深眠」「没有记忆负担的笑」）→ 翻成可见动作（闭眼、呼吸平稳、嘴角缓缓上扬）。
- 禁否定式对比（「不是A不是B而是C」）→ 只写最终状态 C。
- 情绪落到可见信号：高兴=嘴角上扬/眼微眯，恐惧=瞳孔放大/身体后缩，平静=面部放松/眼神放空。
- 不堆叠同义形容词。

# 六、local_prompts（长度 4，每项对应一个 Shot，适配 Singularity / OmniCine）
- 自然语言、动作连贯，不罗列标签，不要任何标题（如 **Character Prompt...**）。
- **不要写时间段/时间标记**（不要 0-5 seconds / 0-5秒 这类）；用连贯的自然语言按动作发生顺序描述（“先…随即…”）。
- 结构顺序：场景与风格 → 动作演进 → 运镜构图 → 光照色调 → 对白 → 声音设计 → 质感词。
- **对白**：用「说话人 said：'中文对白原文'」——台词原文用**英文单引号 \`'...'\` 包裹**、保持中文（禁翻译/换行/方括号标签）；可补 \`Voice:\` 声线、\`Pace:\` 语速。无台词写 no character dialogue。多人同框写明谁说谁不说（避免对口型错人）。
- 每项**末尾加「无字幕」**。
- 语言遵循 \`{{语言}}\`：中文则整段中文（对白引导词也用中文，如「角色说：'台词'」）；无论中英文，台词原文都用**英文单引号包裹**。

## local_prompts 写法示例（一组 4 项，对应同一个四宫格的 4 个 Shot）
> 以「办公室里男主搞定工作 → 女同事惊讶起身 → 男主回头看她 → 两人对视」为例；四项严格按 Shot 顺序，第 1/2/3/4 项分别对应四宫格 左上/右上/左下/右下。
**英文模式（{{语言}}=英文，仅台词中文且英文单引号包裹）：**
[1] Realistic cinematic style, relaxed satisfied mood. The man stops typing, leans back and stretches, then raises a fist with a smug grin. slow dolly in, medium shot, eye-level. Cool daylight from the left window, soft office ambience. The man said: '终于搞定了！' Voice: relaxed and pleased, Pace: medium. quiet keyboard clicks, gentle room tone, precise lip-sync. film grain，无字幕
[2] Realistic cinematic style, surprised tense mood. The woman beside him suddenly looks up with widened eyes and pushes herself up from the desk with both hands. static camera, over-the-shoulder close-up, eye-level. Cold ambient light, shallow depth of field. The woman said: '你居然真做出来了？' Voice: surprised and sharp, Pace: fast. sudden chair scrape, tense room tone，无字幕
[3] Realistic cinematic style, curious mood. The man turns his head toward her, eyebrows raised, a faint confident smile on his lips. slow pan right following his gaze, medium close-up. Warm key light on his face. no character dialogue. soft ambient hum，无字幕
[4] Realistic cinematic style, warm connecting mood. The two lock eyes, the woman slowly breaks into a relieved smile while the man nods lightly. static two-shot, eye-level, balanced composition. Even soft daylight. no character dialogue. warm gentle BGM rises, calm room tone，无字幕
**中文模式（{{语言}}=中文，整段中文、台词仍用英文单引号包裹）：**
[1] 写实电影风格，轻松满足氛围。男人停下打字、向后靠并伸了个懒腰，随即握拳露出得意的笑。缓慢推镜，中景，平视。冷调日光从左侧窗户照入，办公室氛围柔和。男人说：'终于搞定了！'声线轻松愉悦，语速中等。轻微键盘声、柔和环境音、精准对口型。胶片颗粒感，无字幕
[2] 写实电影风格，惊讶紧张氛围。旁边的女人猛地抬头、瞪大眼睛、双手撑桌起身。固定机位，过肩近景，平视。冷调环境光，浅景深。女人说：'你居然真做出来了？'声线惊讶尖锐，语速快。突然的椅子刮擦声、紧张室内环境音，无字幕
[3] 写实电影风格，好奇氛围。男人转头看向她，挑眉，嘴角浮现一丝自信浅笑。镜头向右缓摇跟随他的视线，中近景。暖调主光打在他脸上。无人物对白。轻柔环境嗡鸣，无字幕
[4] 写实电影风格，温暖交汇氛围。两人对视，女人缓缓绽放释然的微笑，男人轻轻点头。固定双人镜头，平视，构图平衡。均匀柔和日光。无人物对白。温暖轻柔的背景音乐渐起、平静室内环境音，无字幕
要点：四项风格统一（都用 {{风格}}）、连贯不写时间段、运镜各异、对白只在该说话的项出现且单引号包裹、无台词项写 no character dialogue/无人物对白、每项末尾「无字幕」。

# 七、四宫格 nano_banana_prompt（必须与 local 四项逐一对应）
开头按**固定顺序**声明参考图（前端按此序拼图）：先按本组台词首次出现顺序列人物「@图1是[角色1]…」，再按出现顺序列道具「@图N是道具:[名]」，最后列主场景「@图N是场景:[名]」。正文只用名字引用、不描述外观（外观由 @图N 提供），并在 ref_assets 里列出一一对应清单。
- 运镜模式三选一并与各 Shot 的 local 一致：渐进式运镜 / 硬切转场 / 混合运镜。
- 4 个面板（左上→右上→左下→右下）逐一对应 local_prompts 第 1/2/3/4 项，同序同内容；把每项的景别/机位/位置/动作/表情/环境光影都画上。
- **只画看得见的东西**（抽象/隐喻/否定式同第五条处理）。
- **去字幕（区分对待）**：禁叠加层（字幕/对白文字/标题卡/水印/logo/UI）；但场景内本应存在的真实文字（招牌/路牌/报纸/屏幕/车牌/包装）可自然出现。
- 结尾声明「画面干净，不要叠加字幕/对白文字/标题卡/水印/logo，但场景内真实文字可自然出现，每个面板16:9，2x2网格排列」。

# 八、shot_transitions（长度 4）
每项是「该 Shot 到下一个 Shot 的转场/镜头语言」（单行，专业运镜词，如：中景缓慢推近至特写、快速横摇切到对话另一方、光线渐暗淡入）。每项末尾加「无字幕」；第 4 项可留空。

# 九、输出格式（合法 JSON，用 \`\`\`json 包裹，JSON 外无任何解释）
\`\`\`json
{
  "person": { "角色1": { "人物": "角色名", "描述": "外貌（复用已有或合理补全）" } },
  "分镜": {
    "1": {
      "global_prompt": "该组整体视觉、场景基底、统一光源与风格（{{语言}}，单行）",
      "local_prompts": ["第1项…，无字幕", "第2项…，无字幕", "第3项…，无字幕", "第4项…，无字幕"],
      "shot_transitions": ["…，无字幕", "…，无字幕", "…，无字幕", ""],
      "nano_banana_prompt": "完整四宫格提示词（中文单行，含@图N声明），4 面板逐一对应 local 第1/2/3/4项；结尾声明画面干净、禁叠加字幕但保留场景内真实文字、每面板16:9、2x2网格",
      "ref_assets": [ { "idx": 1, "type": "character", "name": "角色1名" } ],
      "dialogues": [
        { "panel": 1, "character": "角色名或空", "text": "纯净中文台词或空", "tone": "中文情绪如「愤怒 很强」或空" },
        { "panel": 2, "character": "", "text": "", "tone": "" },
        { "panel": 3, "character": "", "text": "", "tone": "" },
        { "panel": 4, "character": "", "text": "", "tone": "" }
      ],
      "negative_prompt": "英文负面词（只禁叠加层，保留场景文字）：subtitles, caption bar, dialogue text overlay, lower-third, title card, watermark, logo overlay, worst quality, blurry, distorted face, deformed, extra fingers, bad anatomy, multiple panels overlap, split screen artifacts, picture-in-picture",
      "transition": "本组到下一组：cut / smooth / fade"
    }
  }
}
\`\`\`

规则：所有字符串单行无换行；local_prompts 固定 4 项、末尾带「无字幕」、语言遵循 {{语言}}；nano_banana 4 面板与 local 逐一对应；shot_transitions 固定 4 项（末项可空）；dialogues 固定 4 项（text 纯净台词、tone 中文情绪）；幻想生物形态描述完整并在每段重复。`,
            voiceSettings: { textTemplate: "我是{name}，这是我的音色，很高兴认识你", cloneWorkflow: 'vocpm' },
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
                model: 'dall-e-3',
                fgTrim: 0,           // 四宫格切分时每个面板四周向内裁切的像素（用于去掉宫格白边/分隔线），0=不裁切
                // 时间轴音频/图像对齐：图像段比关联音频「多出」的画面时长（秒），前后可分别设置。
                // 让画面在语音开始前 / 结束后各多留一段，避免一开口就切镜或话没说完就转场。
                audioPadHeadSec: 0.5,   // 语音前留白（秒）
                audioPadTailSec: 0.5    // 语音后留白（秒）
            },
            // 合成视频默认参数：进入时间轴(openTimeline)时作为初始值，可在弹窗内临时改动。
            // workflow: 'director'(旧导演台 LTXDirector) | 'singularity'(乱神版V3)
            videoDefaults: {
                workflow: 'director',
                epsilon: 0.9            // 过渡柔和度（0.001 硬切 ~ 1.0 最柔）
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

    // 从后端重新拉取单个项目的最新数据，覆盖内存与本地缓存。
    // 用于「手动刷新」拿到在别处（如 ComfyUI 合成完成、另一标签页）写入的新数据，
    // 而不必整页刷新。失败时保持现有内存数据不变并返回原对象。
    async reloadProject(id) {
        try {
            const r = await (await fetch(this.API + '/api/projects/load', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            })).json();
            if (r && r.success && r.project) {
                if (!this._data) this._data = { projects: [], settings: {} };
                const arr = this._data.projects || (this._data.projects = []);
                const idx = arr.findIndex(p => p.id === id);
                if (idx !== -1) arr[idx] = r.project; else arr.push(r.project);
                try { localStorage.setItem('assest_project_' + id, JSON.stringify(r.project)); } catch (e) {}
                return r.project;
            }
        } catch (e) {
            console.warn('Storage: 重新加载项目失败 ' + id, e && e.message);
        }
        return this.getProject(id);
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
