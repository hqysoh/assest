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

【配音情绪标签库（仅用于 dialogues[].text 的配音文本，可选、克制点缀）】
在 dialogues[].text 的台词中，可以根据情绪在合适位置**偶尔**点缀以下英文标签（一句最多 1~2 个，宁缺毋滥，无明显情绪就不加）：
- 😆 笑声/叹气：[laughing]、[sigh]
- 🤫 停顿/思考：[Uhm]、[Shh]
- ❓ 疑问/确认：[Question-ah]、[Question-ei]、[Question-en]、[Question-oh]、[Confirmation-en]
- ❗ 惊讶/情绪：[Surprise-wa]、[Surprise-yo]、[Surprise-ah]、[Surprise-oh]、[Dissatisfaction-hnn]
标签按原文保留方括号与英文，直接嵌入中文台词中，例如：text 写「[Surprise-wa] 真的假的？」「原来是这样啊 [Confirmation-en]」。
⚠ 这些标签**只能出现在 dialogues[].text**（送去配音的文本）里；**严禁出现在 local_prompts、global_prompt、nano_banana_prompt、shot_transitions 等任何画面提示词中**（画面提示词里的台词保持纯净中文，不带任何标签）。

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

【关键一致性铁律 — 四宫格图必须与 local_prompts 完全对应】
- 四宫格的 4 个面板（左上→右上→左下→右下）必须**逐一对应** local_prompts 的第 1/2/3/4 项，**同序、同内容**。
- 写每个面板时，把对应 local_prompt 里的核心画面信息**全部落到画面上**：景别、机位、说话人在画面中的位置（左/右/中央/前景/后景）、主体动作、面部表情与手势、环境与光影。做到「看图就能对上那句 local」。
- 严禁出现 local 里没有的人物/道具/动作，也不要漏掉 local 里明确写到的关键元素（如手机、武器、特定手势、视线方向）。
- 画面信息要**丰富具体**：每个面板都要交代清楚——谁、在画面哪个位置、什么景别与机位、在做什么动作、什么表情、周围环境与主光源方向/色调。不要笼统一句「人物在说话」。

【去字幕铁律 — 四宫格图严禁任何文字】
- nano_banana_prompt 正文里必须明确写出「画面干净、无任何字幕、无对白文字、无字母、无水印、无logo、无UI、无标题卡」。
- 即使有台词，台词只用于配音与对口型，**绝对不要把台词文字画进画面**；画面中人物可以张嘴说话，但不出现任何文字。
- 负面要求里务必包含：no subtitles, no captions, no text, no letters, no words, no watermark, no logo, no caption bar。

# 六、global_prompt 与 local_prompts（核心，决定成片质量）
- global_prompt：单段连贯中文，融合该组 4 个 Shot 的整体视觉描述、场景基底、统一光源与风格（涉及幻想生物须含完整形态描述并在每段重复）。

- local_prompts：返回长度为 4 的数组，每项对应一个 Shot（面板），适配 **Singularity-LTX-2.3 OmniCine** 模型，是**一整段连贯、自然语言的英文画面描述**（信息量要足、动作连贯）。

  【Singularity / OmniCine 提示词铁律 — 必看】
  ① **语言规则**：除「说话内容（对白）」保留中文外，**其余一律使用英文**。不要出现 `**Character Prompt (for AI Image Generation):**` 之类的任何标题/小标题，直接输出翻译后的自然语言描述。
  ② **自然语言、动作连贯**：用连贯的句子描述，不要罗列要素标签。
  ③ **时间分段叙事**：在同一段里按时间推进描述「动作演变 + 运镜 + 光照 + 声音」，用英文时间标记，如 `0-5 seconds, ...`、`5-10 seconds, ...`、`10-15 seconds, ...`（秒数根据该 Shot 时长合理划分；短镜头可只用一个区间）。
  ④ **建议结构顺序**（全英文，自然衔接）：
     - 开头：场景与风格（如 `Cinematic and realistic style, dynamic and fierce mood.`）
     - 动作描述（分时间段，描述人物动作如何随时间演变）
     - 运镜与构图（分时间段，如 `slow dolly in`、`full shot with dynamic tracking movement`、`tight close-up, static camera`）
     - 光照与色调（如 `Realistic indoor gym lighting, strong key light, high contrast shadows, desaturated cool tones.`）
     - 对白（见下条）
     - 声音设计（如 `Ambient gym sounds, sudden dramatic BGM crescendo, precise lip-sync.`）
     - 质感词（如 `film grain, cinematic bokeh`）
     - 末尾 `无字幕`
  ⑤ **对白处理（关键，唯一中文）**：用英文句式引出说话人 + 冒号 + 中文对白原文，格式：`The woman with blue hair said：等下有你好看的，渣滓！`。冒号后是**中文对白原文**（严禁翻译成英文、严禁加引号、严禁换行、严禁出现 [laughing]/[Surprise-wa] 等配音标签）。可在对白后补充英文声线/语速，如 `Voice: clear and sharp, Pace: fast.`。说话动词用英文：said / whispered / shouted / asked / murmured / narrated（画外音 voice-over）。
  ⑥ **无台词的 Shot**：用英文写明 `no character dialogue`（或 `无人物对白`），只描述画面与环境音。
  ⑦ **多人同框**：用英文写明谁在说话、谁不说话（如 `the man stays silent and does not move his lips`），避免对口型驱动错人。

  【风格 / 运镜 参考词（可按需选用，均为英文优先）】
  - 风格：Cinematic Style / Anime Style / Realistic Style / Realistic Cyberpunk Aesthetic / 3D Game Cinematic Render / Vintage Film Grain Style / Mysterious and Suspenseful Mood / Melancholic Golden Hour / Cozy and Warm Slice-of-Life / Dark and Gritty Urban Noir
  - 运镜：close-up / slow dolly in (镜头缓缓推进) / over-the-shoulder medium shot (过肩中景) / static camera (固定机位) / low-angle tilt-up pan (低角度仰摄摇镜头) / lateral tracking (横移追随) / tracking shot (追随镜头) / handheld camera (手持镜头) / oblique angle (斜角镜头) / Dutch angle (荷兰角)

  【收尾】每个 local_prompt **末尾必须加「无字幕」三个字**（画面不渲染任何字幕/字母/文字水印）。

  【完整示例（仅示范风格，实际按剧本生成）】
  `Cinematic and realistic style, dynamic and fierce mood. 0-5 seconds, woman is gently adjusting and styling her hair, showing a calm preparation. 5-10 seconds, switches to a full shot, she becomes passionate and energetic, performing a series of intense boxing combinations with sharp punches. 10-15 seconds, switches to a tight facial close-up shot, she stares directly into the camera with an aggressive glare. 0-5 seconds, slow dolly in, emphasis composition. 5-10 seconds, full shot with dynamic tracking movement. 10-15 seconds, tight close-up, static camera. Realistic indoor gym lighting, strong key light, high contrast shadows, desaturated cool tones. 10-15 seconds，The woman with blue hair said：等下有你好看的，渣滓！Voice: clear and sharp, Pace: fast. Ambient gym sounds, wind resistance from fast punches, sudden dramatic BGM crescendo, precise lip-sync. film grain, cinematic bokeh，无字幕`

- shot_transitions：返回长度为 4 的数组，每项是「该 Shot 到下一个 Shot 的转场 / 镜头语言连贯性描述」（中文单行，用专业运镜词，如：镜头由中景缓慢推近至特写、人物转身向右带出下一场景、光线渐暗淡入下一镜、快速横摇切到对话另一方…）。**每项末尾也必须加「无字幕」**。第 4 项（最后一个面板）可留空字符串。

# 七、输出格式（必须是合法 JSON，可被 JSON.parse 解析；用 \`\`\`json 包裹；JSON 外无任何解释）
{
  "person": { "角色1": { "人物": "角色名", "描述": "外貌描述（复用已有设定或合理补全）" } },
  "分镜": {
    "1": {
      "global_prompt": "该组整体视觉描述、场景基底与统一光源（中文单行）",
      "local_prompts": ["Cinematic and realistic style, calm preparation mood. 0-5 seconds, the man stops typing and stretches lazily at the desk, then raises his fist lightly with a smug grin. slow dolly in, medium shot, eye-level. Cool white daylight slants in from the left window, soft office ambience. 0-5 seconds，the man said：终于搞定了！Voice: relaxed and pleased, Pace: medium. quiet keyboard clicks, gentle room tone, precise lip-sync. film grain，无字幕", "Cinematic and realistic style, surprised tense mood. 0-5 seconds, the woman in the center suddenly looks up with widened eyes and pushes herself up from the desk with both hands. static camera, over-the-shoulder close-up, eye-level. Cold ambient office light, shallow depth of field. no character dialogue. sudden chair scrape, sharp room tone, tense BGM sting，无字幕", "面板3：同样的英文自然语言描述（动作+运镜+光照+声音），如有对白则 said：中文对白，无字幕", "面板4：同上英文自然语言描述，无字幕"],
      "shot_transitions": ["镜头由中景缓慢推近至近景，自然过渡，无字幕", "快速横摇切到对话另一方，无字幕", "光线渐暗淡入下一镜，无字幕", ""],
      "nano_banana_prompt": "完整四宫格提示词（中文单行，含@图N声明）。4 个面板须逐一对应 local_prompts 第1/2/3/4项，把每项的景别/机位/位置/动作/表情/环境光影都画到对应面板上；正文结尾必须声明「画面干净、无任何字幕、无对白文字、无字母、无水印、无logo，每个面板16:9，2x2网格排列」",
      "ref_assets": [
        { "idx": 1, "type": "character", "name": "角色1名" },
        { "idx": 2, "type": "prop", "name": "道具名" },
        { "idx": 3, "type": "scene", "name": "场景名" }
      ],
      "dialogues": [
        { "panel": 1, "character": "角色名或空", "text": "台词中文原文或空（可按情绪点缀 [Surprise-wa]/[sigh] 等配音标签）", "tone": "语气或空" },
        { "panel": 2, "character": "", "text": "", "tone": "" },
        { "panel": 3, "character": "", "text": "", "tone": "" },
        { "panel": 4, "character": "", "text": "", "tone": "" }
      ],
      "negative_prompt": "英文负面词：subtitles, captions, caption bar, text, letters, words, on-screen text, dialogue text, watermark, logo, UI, title card, worst quality, blurry, distorted face, deformed, extra fingers, bad anatomy, text overlay, multiple panels overlap, split screen artifacts, picture-in-picture, frame within frame。涉及幻想生物追加其现实形态反义词。",
      "transition": "本组结束到下一组的转场建议：cut(硬切) / smooth(平滑过渡) / fade(淡入淡出)"
    }
  }
}

规则：所有字符串单行无换行；local_prompts 适配 Singularity/OmniCine：**除中文对白外一律英文自然语言**、不要任何标题（如 **Character Prompt...**）、动作连贯、按时间分段（如 0-5 seconds / 5-10 seconds，依镜头时长划分）、依次自然衔接「场景风格→动作→运镜构图→光照色调→对白→声音设计→质感」；对白格式为 `英文说话人 said：中文对白原文`（冒号后中文原文，严禁翻译成英文、严禁加引号、严禁换行、严禁出现 [Surprise-wa] 等配音标签），无对白写 `no character dialogue`；local_prompts 固定 4 项、每项末尾带「无字幕」；nano_banana_prompt 的 4 个面板必须与 local_prompts 第1/2/3/4项逐一对应（同序、同画面内容），并在正文中明确声明「画面干净、无字幕、无任何文字/字母/水印/logo」；shot_transitions 固定 4 项（最后一项可空，其余末尾带「无字幕」）；dialogues 固定 4 项（无台词的面板字段留空，text 可按情绪偶尔点缀配音情绪标签如 [Surprise-wa]/[Confirmation-en]）；配音情绪标签**只允许出现在 dialogues[].text**，严禁出现在 local_prompts/global_prompt/nano_banana_prompt/shot_transitions 等画面提示词中；幻想生物形态描述完整。`,
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
