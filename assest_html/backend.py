#!/usr/bin/env python3
import json
import os
import sys
import sqlite3
import subprocess
import re
import time
import random
import base64
import requests
import threading
import queue
import shutil
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

COMFYUI_URL = "http://127.0.0.1:8188"
TTS_WORKFLOW_PATH = os.path.join(os.path.dirname(__file__), "..", "workflow-api", "Qwen3-TD-TTS 语音设计.json")
# VoxCPM2 语音设计工作流（备选，RunningHub_VoxCPM_Generate 节点 + 两个 CR Prompt Text）
TTS_DESIGN_VOXCPM_WORKFLOW_PATH = os.path.join(os.path.dirname(__file__), "..", "workflow-api", "VoxCPM2-声音设计.json")
# 语音设计（音色生成）工作流可选项：key → 文件路径（前端在设置中选择，默认 qwen3）
VOICE_DESIGN_WORKFLOWS = {
    'qwen3': TTS_WORKFLOW_PATH,
    'voxcpm': TTS_DESIGN_VOXCPM_WORKFLOW_PATH,
}

BASE_DIR = os.path.dirname(__file__)
DB_FILE = os.path.join(BASE_DIR, "data.db")
MEDIA_DIR = os.path.join(BASE_DIR, "media")
# 视频历史「拖放/上传导入」落盘目录：浏览器拿不到本地绝对路径，故由后端落盘一次到此目录，
# 之后视频历史只索引该绝对路径（不再二次复制），与 ComfyUI 生成的视频共用 /api/video_file 播放/拖出。
IMPORT_DIR = os.path.join(BASE_DIR, "imports")
COMFYUI_BASE = None

tts_queue = queue.Queue()
tts_busy = threading.Lock()
tts_results = {}

# ==================== Async Image Jobs ====================
# 图像生成异步任务：前端提交后立即拿到 task_id，后台线程实际调用图像 API，
# 结果暂存于内存。即使前端刷新/关闭，任务仍会跑完并保留结果，前端重连后可凭
# task_id 取回图像，避免“刷新即丢失、白白扣费”。
image_jobs = {}            # task_id -> {status, images, error, ts, prompt}
image_jobs_lock = threading.Lock()
IMAGE_JOB_TTL = 1800       # 任务结果保留 30 分钟

# ==================== 分镜 / 四宫格 / 视频 异步任务 ====================
# 统一的通用异步任务表：CC 分镜生成、四宫格 gpt-image-2 编辑、导演台视频生成
# 都用这一套（提交→task_id→轮询），刷新/关闭不丢任务。
sb_jobs = {}               # task_id -> {kind, status, result, error, ts}
sb_jobs_lock = threading.Lock()
SB_JOB_TTL = 3600          # 分镜/视频类任务保留 1 小时（生成更耗时）

# 导演台 / TTS 克隆工作流路径
DIRECTOR_WORKFLOW_PATH = os.path.join(os.path.dirname(__file__), "..", "workflow-api", "AI代码侠土豆-LTX2.3导演台工作流.json")
# Singularity（乱神版 V3）导演台工作流：基于 easy timelineEditor 的 timeline_data 格式
DIRECTOR_SINGULARITY_WORKFLOW_PATH = os.path.join(os.path.dirname(__file__), "..", "workflow-api", "Ltx2.3 Singularity+EasyMedia导演工作台(乱神版)V3.json")
# Yusu 导演台工作流：核心节点 YusuLTXDirector（暴露原生 LTXV 采样链 + LoRA + 运动轨）。
# timeline_data 格式与旧 LTXDirector 高度同构（segments + audioSegments），故注入逻辑基本复用旧导演台。
DIRECTOR_YUSU_WORKFLOW_PATH = os.path.join(os.path.dirname(__file__), "..", "workflow-api", "yusu-工作流.json")
TTS_CLONE_WORKFLOW_PATH = os.path.join(os.path.dirname(__file__), "..", "workflow-api", "vocpm语音克隆.json")
# Qwen3-TD-TTS 语音克隆工作流（备选，TDQwen3TTSVoiceClone 节点）
TTS_CLONE_QWEN3_WORKFLOW_PATH = os.path.join(os.path.dirname(__file__), "..", "workflow-api", "Qwen3-TD-TTS语音克隆.json")
# IndexTTS-2 语音克隆工作流（带情感参考，easy indexTTSEmotionVector / easy indexTTSGenerate 节点）
TTS_CLONE_INDEXTTS_WORKFLOW_PATH = os.path.join(os.path.dirname(__file__), "..", "workflow-api", "index-TTS2语音克隆+情感参考.json")
# 语音克隆工作流可选项：key → 文件路径（前端在设置中选择，默认 vocpm）
TTS_CLONE_WORKFLOWS = {
    'vocpm': TTS_CLONE_WORKFLOW_PATH,
    'qwen3': TTS_CLONE_QWEN3_WORKFLOW_PATH,
    'indextts': TTS_CLONE_INDEXTTS_WORKFLOW_PATH,
}

# IndexTTS-2 情感分数取值范围（节点 easy indexTTSEmotionVector）：0 ~ 1.4
INDEXTTS_EMOTION_KEYS = ['Happy', 'Angry', 'Sad', 'Fear', 'Hate', 'Low', 'Surprise', 'Neutral']
INDEXTTS_EMOTION_MIN = 0.0
INDEXTTS_EMOTION_MAX = 1.4


def _new_task_id(prefix):
    return f"{prefix}_{int(time.time()*1000)}_{random.randint(1000,9999)}"


def _cleanup_sb_jobs():
    now = time.time()
    with sb_jobs_lock:
        for k in [k for k, v in sb_jobs.items() if now - v.get('ts', now) > SB_JOB_TTL]:
            sb_jobs.pop(k, None)


def _sb_job_set(task_id, **kw):
    with sb_jobs_lock:
        job = sb_jobs.get(task_id)
        if job is not None:
            job.update(ts=time.time(), **kw)


def _sb_job_cancelled(task_id):
    """任务是否被请求取消（worker 在轮询中检查此标志以真实打断）。"""
    with sb_jobs_lock:
        job = sb_jobs.get(task_id)
        return bool(job and job.get('cancelled'))


def _sb_job_get(task_id):
    with sb_jobs_lock:
        job = sb_jobs.get(task_id)
        return dict(job) if job else None


def _submit_sb_job(kind, worker, params):
    """提交一个异步任务，返回 task_id。worker(task_id, params) 在后台线程执行。"""
    _cleanup_sb_jobs()
    task_id = _new_task_id(kind)
    with sb_jobs_lock:
        sb_jobs[task_id] = {'kind': kind, 'status': 'pending', 'result': None, 'error': None, 'ts': time.time()}
    threading.Thread(target=worker, args=(task_id, params), daemon=True).start()
    return task_id


def _call_image_edit_api(prompt, image_b64_list, api_url, api_key, model='gpt-image-2', size='auto', quality='auto', n=1):
    """调用 gpt-image-2 图片编辑接口 /v1/images/edits（multipart/form-data，支持多张参考图）。
    image_b64_list: 参考图的 base64（不含 data: 前缀）列表，会作为 image[] 多文件上传。
    返回 (images_b64, error)。"""
    base = (api_url or 'https://token.ithinkai.cn/v1').rstrip('/')
    # 兼容用户填了完整端点或仅填到 /v1
    if base.endswith('/images/generations'):
        base = base[:-len('/images/generations')]
    url = base if base.endswith('/images/edits') else base + '/images/edits'

    files = []
    for idx, b64 in enumerate(image_b64_list or []):
        try:
            raw = base64.b64decode(b64)
        except Exception:
            continue
        files.append(('image', (f'ref_{idx}.png', raw, 'image/png')))
    data = {'model': model, 'prompt': prompt, 'n': str(n)}
    if size and size != 'auto':
        data['size'] = size
    if quality and quality != 'auto':
        data['quality'] = quality
    print(f"[EDIT] {url} model={model} refs={len(files)} size={size} quality={quality}")
    if not files:
        # 没有参考图时退化为纯文生图（部分模型 edits 要求至少一张图）
        return None, '缺少参考图（人物/道具/场景）'
    resp = requests.post(url, data=data, files=files,
                         headers={'Authorization': f'Bearer {api_key}'}, timeout=600)
    if resp.status_code != 200:
        err = f'API {resp.status_code}'
        try:
            ed = resp.json(); em = ed.get('error', {})
            if isinstance(em, dict):
                err = em.get('message', '') or str(em)
        except Exception:
            err = (resp.text or err)[:200]
        return None, err
    out = resp.json()
    images = []
    for item in out.get('data', []):
        if item.get('b64_json'):
            images.append(item['b64_json'])
        elif item.get('url'):
            ir = requests.get(item['url'], timeout=120)
            if ir.status_code == 200:
                images.append(base64.b64encode(ir.content).decode('utf-8'))
    if images:
        return images, None
    return None, '未获取到图像数据'


def _run_fourgrid_job(task_id, params):
    """后台执行四宫格生成（gpt-image-2 编辑，多参考图）。"""
    try:
        images, error = _call_image_edit_api(
            params['prompt'], params.get('ref_images', []),
            params.get('api_url'), params.get('api_key'),
            params.get('model', 'gpt-image-2'), params.get('size', 'auto'),
            params.get('quality', 'auto'), 1)
        if images:
            _sb_job_set(task_id, status='done', result={'images': images})
        else:
            _sb_job_set(task_id, status='error', error=error or '未知错误')
    except Exception as e:
        import traceback; traceback.print_exc()
        _sb_job_set(task_id, status='error', error=str(e))


def _find_claude_bin():
    """跨平台定位 claude 可执行文件。Windows 上通常是 claude.cmd / claude.exe。"""
    for name in ('claude', 'claude.cmd', 'claude.exe', 'claude.ps1'):
        p = shutil.which(name)
        if p:
            return p
    return 'claude'  # 兜底，交给 shell 解析


def _kill_proc_tree(proc):
    """跨平台杀掉一个子进程及其整个进程树。
    Windows 用 taskkill /T /F 杀进程树（claude 常是 .cmd 包装，必须连子进程一起杀，
    否则真正的 node/claude 子进程仍持有 claude_output.txt 句柄，导致 WinError 32）。"""
    if proc is None:
        return
    try:
        if proc.poll() is not None:
            return  # 已结束
    except Exception:
        pass
    try:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=10)
        else:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
    except Exception as e:
        print(f'[CC] kill proc tree failed: {e}')
    finally:
        try:
            proc.wait(timeout=3)
        except Exception:
            pass


def _safe_remove(path, retries=5, delay=0.3):
    """删除文件，容忍 Windows 上偶发的占用（WinError 32）：重试，仍失败则忽略。"""
    if not os.path.exists(path):
        return True
    for _ in range(retries):
        try:
            os.remove(path)
            return True
        except OSError:
            time.sleep(delay)
    print(f'[CC] 文件仍被占用，跳过删除：{path}')
    return False


def run_claude_cc(prompt_file, output_file, timeout=600, cwd=None, on_proc=None):
    """跨平台调用 Claude Code：以 prompt_file 作为 stdin，stdout/stderr 重定向到 output_file。
    用 Python 文件句柄替代 shell 的 < > 重定向，规避 Windows/macOS shell 差异。
    on_proc(proc): 拿到 Popen 句柄后回调（用于把进程存到任务上，便于打断时杀进程树）。
    返回 output_file 的文本内容。被打断时进程被杀，函数正常返回已写入的内容。"""
    claude = _find_claude_bin()
    args = [claude, '--verbose', '--output-format=stream-json',
            '--permission-mode=bypassPermissions',
            '--disallowed-tools', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion',
            '--print']
    # Windows 下 .cmd/.ps1 需要 shell=True 才能被正确解析
    use_shell = os.name == 'nt' and claude.lower().endswith(('.cmd', '.ps1', '.bat'))
    # Windows 下新建进程组，便于 taskkill /T 整树清理
    popen_kw = {}
    if os.name == 'nt':
        popen_kw['creationflags'] = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    proc = None
    with open(prompt_file, 'r', encoding='utf-8') as fin, \
         open(output_file, 'w', encoding='utf-8') as fout:
        proc = subprocess.Popen(
            args if not use_shell else ' '.join(f'"{a}"' for a in args),
            stdin=fin, stdout=fout, stderr=subprocess.STDOUT,
            text=True, cwd=cwd, shell=use_shell, **popen_kw)
        if on_proc:
            try:
                on_proc(proc)
            except Exception:
                pass
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_proc_tree(proc)
            raise
    log_text = ''
    if os.path.exists(output_file):
        with open(output_file, 'r', encoding='utf-8', errors='ignore') as f:
            log_text = f.read()
    return log_text


def _loads_lenient(s):
    """尽力把一段可能不严格的 JSON 文本解析为对象。
    依次尝试：① 直接 json.loads；② 修复字符串值内部未转义的裸双引号后再解析。
    模型常见错误：在中文 JSON 字符串里写成 揭示"备份文件"真相（裸英文引号），破坏 JSON。"""
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:
        pass
    # 修复裸引号：当一个 " 的左右两侧都是“非结构字符”（不是 : , { } [ ] 和空白）时，
    # 视为字符串值内部误用的引号，转义为 \"。这样不会动到正常的键/值边界引号。
    try:
        fixed = re.sub(r'(?<=[^\s:,{}\[\]])"(?=[^\s:,{}\[\]])', r'\\"', s)
        return json.loads(fixed)
    except Exception:
        return None


def _extract_json_block(text):
    """从 CC 输出中尽力提取一个合法 JSON 对象。优先匹配 ```json fenced 块，
    再退化为通用花括号块；解析时对非严格 JSON（裸引号等）做容错修复。"""
    if not text:
        return None
    # 1. ```json ... ``` 围栏
    m = re.search(r'```json\s*([\s\S]*?)```', text)
    if m:
        obj = _loads_lenient(m.group(1))
        if obj is not None:
            return obj
    # 2. 优先匹配含已知关键字段的花括号块；再退化为"第一个 { 到最后一个 }"的通用块
    candidates = []
    for pat in [r'\{[\s\S]*"分镜"[\s\S]*\}', r'\{[\s\S]*"person"[\s\S]*\}',
                r'\{[\s\S]*"characters"[\s\S]*\}']:
        mm = re.search(pat, text)
        if mm:
            candidates.append(mm.group())
    # 通用：从第一个 { 到最后一个 }
    fi, li = text.find('{'), text.rfind('}')
    if fi != -1 and li != -1 and li > fi:
        candidates.append(text[fi:li + 1])

    for blob in candidates:
        # 先整体容错解析
        obj = _loads_lenient(blob)
        if obj is not None:
            return obj
        # 再从右侧逐步收缩，应对结尾多余文本
        for end in range(len(blob), max(len(blob) - 4000, 0), -1):
            obj = _loads_lenient(blob[:end])
            if obj is not None:
                return obj
    return None


def _scan_dir_for_storyboard(od, since_ts=0, exclude=None):
    """兜底：CC 有时会用 Write 工具把分镜 JSON 写成文件（如 storyboard_output.json），
    而非在 stdout 输出 ```json 块。此时扫描工作目录下**以 storyboard 开头**的 *.json 文件，
    提取含『分镜』/『person』的对象（只认 storyboard 前缀，避免误读目录里其它 json）。
    since_ts: 只看该时间之后修改的文件；exclude: 要排除的文件名集合（如我们自己回写的 storyboard.json）。
    返回 (result_obj, filepath) 或 (None, None)。"""
    exclude = exclude or set()
    try:
        cands = []
        for name in os.listdir(od):
            low = name.lower()
            if not (low.startswith('storyboard') and low.endswith('.json')):
                continue
            if name in exclude:
                continue
            fp = os.path.join(od, name)
            try:
                mt = os.path.getmtime(fp)
            except Exception:
                continue
            if mt < since_ts - 1:   # 留 1s 容差
                continue
            cands.append((-mt, fp))   # 修改时间新的优先
        cands.sort()
        for _, fp in cands:
            try:
                with open(fp, 'r', encoding='utf-8', errors='ignore') as f:
                    obj = _extract_json_block(f.read())
                if obj and ('分镜' in obj or 'person' in obj):
                    return obj, fp
            except Exception:
                continue
    except Exception:
        pass
    return None, None


def _result_is_api_error(log_text):
    """从 CC 输出里识别其自身的 API 错误（如连接被拒、限流），返回错误文案或 None。"""
    for line in log_text.split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get('type') == 'result' and obj.get('is_error') and obj.get('result'):
            return str(obj['result'])[:200]
    return None


def _run_storyboard_job(task_id, params):
    """调用 Claude Code 生成分镜 JSON。把剧本 + 已有人物/道具/场景上下文 + 分镜提示词
    一起喂给 CC，解析出 {person, 分镜}。"""
    try:
        pid = params.get('project_id', 'default')
        od = os.path.join(BASE_DIR, 'extracts', pid, 'storyboard')
        os.makedirs(od, exist_ok=True)

        # 组装上下文：已有设定（供 CC 复用角色外貌、保持一致）
        ctx = {
            'characters': params.get('characters', []),
            'props': params.get('props', []),
            'scenes': params.get('scenes', []),
        }
        sp = os.path.join(od, 'script.txt')
        with open(sp, 'w', encoding='utf-8') as f:
            f.write(params.get('script', ''))

        full_prompt = (
            params.get('prompt', '') +
            "\n\n【已有人物/道具/场景设定（请复用，保持一致）】\n" +
            json.dumps(ctx, ensure_ascii=False, indent=2) +
            "\n\n【剧本文件路径】" + sp +
            "\n\n【输出要求（务必遵守）】请阅读剧本并严格按要求生成分镜 JSON。"
            "最终结果请用 Write 工具写入当前工作目录下的文件 storyboard_output.json"
            "（仅写这一个文件，内容是纯 JSON，不要带 ```json 围栏），"
            "同时也把同样的 JSON 用 ```json 代码块输出到回复中。两者内容必须完全一致。"
        )
        pf = os.path.join(od, 'prompt.txt')
        with open(pf, 'w', encoding='utf-8') as f:
            f.write(full_prompt)

        lf = os.path.join(od, 'claude_output.txt')
        _safe_remove(lf)
        # 清掉上一次 CC 写出的分镜文件，避免兜底扫描读到旧结果
        _safe_remove(os.path.join(od, 'storyboard_output.json'))
        if _sb_job_cancelled(task_id):
            _sb_job_set(task_id, status='cancelled', error='已打断'); return
        _sb_job_set(task_id, status='running')
        run_ts = time.time()
        log_text = run_claude_cc(pf, lf, timeout=600, cwd=od,
                                 on_proc=lambda pr: _sb_job_set(task_id, proc=pr))
        if _sb_job_cancelled(task_id):
            _sb_job_set(task_id, status='cancelled', error='已打断'); return

        # 解析：① 逐行找 result 事件里的 JSON；② 全文兜底；
        # ③ 兜底扫描 CC 写出的 storyboard*.json 文件（CC 常用 Write 工具落盘而非 stdout 输出）
        result_obj = None
        for line in log_text.split('\n'):
            try:
                obj = json.loads(line)
                if obj.get('type') == 'result' and 'result' in obj:
                    result_obj = _extract_json_block(obj['result'])
                    if result_obj:
                        break
            except Exception:
                continue
        if not result_obj:
            result_obj = _extract_json_block(log_text)
        if not (result_obj and ('分镜' in result_obj or 'person' in result_obj)):
            scanned, fp = _scan_dir_for_storyboard(od, since_ts=run_ts, exclude={'storyboard.json'})
            if scanned:
                print(f'[SB] 从 CC 写出的文件解析到分镜：{fp}')
                result_obj = scanned

        if result_obj and ('分镜' in result_obj or 'person' in result_obj):
            with open(os.path.join(od, 'storyboard.json'), 'w', encoding='utf-8') as f:
                json.dump(result_obj, f, ensure_ascii=False, indent=2)
            _sb_job_set(task_id, status='done', result={
                'person': result_obj.get('person', {}),
                'storyboards': result_obj.get('分镜', {}),
                'output': log_text[:4000],
            })
        else:
            api_err = _result_is_api_error(log_text)
            if api_err:
                _sb_job_set(task_id, status='error', error='Claude 调用失败：' + api_err)
            else:
                _sb_job_set(task_id, status='error', error='无法解析分镜 JSON（请检查 Claude 是否可用 / 输出是否包含分镜）')
    except subprocess.TimeoutExpired:
        _sb_job_set(task_id, status='error', error='分镜生成超时（CC 执行 >10 分钟）')
    except Exception as e:
        import traceback; traceback.print_exc()
        _sb_job_set(task_id, status='error', error=str(e))


def _run_extract_job(task_id, params):
    """调用 Claude Code 从剧本提取人物/道具/场景。强化提示词（明确 schema + ```json 围栏），
    并复用鲁棒的 _extract_json_block 解析，避免 CC 输出格式略有出入就抓不到。"""
    try:
        pid = params.get('project_id', 'default')
        od = os.path.join(BASE_DIR, 'extracts', pid)
        os.makedirs(od, exist_ok=True)
        sp = os.path.join(od, 'script.txt')
        with open(sp, 'w', encoding='utf-8') as f:
            f.write(params.get('script', ''))

        # 强化提示词：明确字段 schema，并要求用 ```json 围栏包裹，便于稳定解析
        schema_hint = (
            "\n\n【任务】阅读剧本，提取其中的人物、道具、场景。\n"
            "【剧本文件路径】" + sp + "\n"
            "【输出要求】只输出一个 JSON 对象，用 ```json 代码块包裹，结构严格如下：\n"
            "```json\n"
            "{\n"
            '  "characters": [{"name": "角色名", "description": "外貌/性格/身份等描述", "voice": "音色/口音描述(可空)"}],\n'
            '  "props": [{"name": "道具名", "description": "外观/用途描述"}],\n'
            '  "scenes": [{"name": "场景名", "description": "环境/氛围描述"}]\n'
            "}\n"
            "```\n"
            "字段名必须是英文 characters/props/scenes/name/description/voice。"
            "没有的类别给空数组。不要输出 JSON 以外的解释文字。"
        )
        fp = (params.get('prompt', '') or '') + schema_hint
        pf = os.path.join(od, 'prompt.txt')
        with open(pf, 'w', encoding='utf-8') as f:
            f.write(fp)
        lf = os.path.join(od, 'claude_output.txt')
        _safe_remove(lf)
        if _sb_job_cancelled(task_id):
            _sb_job_set(task_id, status='cancelled', error='已打断'); return
        _sb_job_set(task_id, status='running')
        log_text = run_claude_cc(pf, lf, timeout=300, cwd=od,
                                 on_proc=lambda pr: _sb_job_set(task_id, proc=pr))
        if _sb_job_cancelled(task_id):
            _sb_job_set(task_id, status='cancelled', error='已打断'); return

        # 解析：优先逐行找 result 事件里的 JSON 块，再兜底全文
        result_obj = None
        for line in log_text.split('\n'):
            try:
                obj = json.loads(line)
                if obj.get('type') == 'result' and 'result' in obj:
                    result_obj = _extract_json_block(obj['result'])
                    if result_obj:
                        break
            except Exception:
                continue
        if not result_obj:
            result_obj = _extract_json_block(log_text)

        chars = (result_obj or {}).get('characters', []) or []
        props = (result_obj or {}).get('props', []) or []
        scenes = (result_obj or {}).get('scenes', []) or []
        if chars or props or scenes:
            with open(os.path.join(od, 'characters.json'), 'w', encoding='utf-8') as f:
                json.dump({'characters': chars, 'props': props, 'scenes': scenes}, f, ensure_ascii=False, indent=2)
            _sb_job_set(task_id, status='done', result={
                'characters': chars, 'props': props, 'scenes': scenes,
                'output': log_text[:5000],
            })
        else:
            _sb_job_set(task_id, status='error',
                        error='无法解析提取结果 JSON（请检查 Claude 是否可用 / 调整提示词）')
    except subprocess.TimeoutExpired:
        _sb_job_set(task_id, status='error', error='提取超时（CC 执行 >5 分钟）')
    except Exception as e:
        import traceback; traceback.print_exc()
        _sb_job_set(task_id, status='error', error=str(e))


def _call_image_api(prompt, api_url, api_key, model, size, quality, n=1):
    """实际调用图像生成 API，返回 (images, error)。images 为 base64 列表。"""
    url = (api_url or 'https://token.ithinkai.cn/v1').rstrip('/')
    if not url.endswith('/images/generations'):
        url += '/images/generations'
    body = {'model': model, 'prompt': prompt, 'n': n, 'size': size, 'response_format': 'b64_json'}
    if quality and quality != 'auto':
        body['quality'] = quality
    print(f"[IMG] {url} model={model} size={size}")
    resp = requests.post(url, json=body,
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}, timeout=300)
    if resp.status_code != 200:
        err_msg = f'API {resp.status_code}'
        try:
            ed = resp.json(); em = ed.get('error', {})
            if isinstance(em, dict):
                err_msg = em.get('message', '') or str(em)
                if len(err_msg) > 120: err_msg = err_msg[:120] + '...'
        except Exception:
            pass
        return None, err_msg
    data = resp.json()
    images = []
    for item in data.get('data', []):
        if 'b64_json' in item:
            images.append(item['b64_json'])
        elif 'url' in item:
            ir = requests.get(item['url'], timeout=60)
            if ir.status_code == 200:
                images.append(base64.b64encode(ir.content).decode('utf-8'))
    if images:
        return images, None
    return None, '未获取到图像数据'


# ==================== 文本大模型（LLM）：分镜提示语优化 / 改写 ====================
# DeepSeek / OpenAI 兼容网关：POST {base}/chat/completions，Bearer 鉴权，标准 messages 格式。
# 默认 base=https://api.deepseek.com，模型=deepseek-v4-flash（用户可在设置里改）。

# 优化单条 local 提示语的默认系统提示词（可被设置覆盖）。{script} 处会注入剧本作参考。
DEFAULT_OPTIMIZE_PROMPT = (
    "你是专业的影视分镜画面提示词优化师。下面给你整部剧本作为背景参考，"
    "请把用户提供的某条分镜画面提示语优化得更具电影感：补充镜头语言（景别/机位/运镜）、"
    "光线氛围、人物动作与表情的连续细节，保持原意与人物/场景一致，避免出现字幕文字。"
    "严格要求：只输出优化后的提示语正文本身，不要任何解释、前后缀、引号或标题。\n\n"
    "【剧本背景参考】\n{script}"
)

# 把一条 local 提示语扩写成「4格连续四宫格」各自描述的默认系统提示词（可被设置覆盖）。
DEFAULT_EXPAND_PROMPT = (
    "你是专业的影视分镜师。下面给你整部剧本作为背景参考。"
    "请把用户提供的这一条分镜，拆解成【4个连续镜头】（构成 2×2 四宫格，顺序为左上→右上→左下→右下），"
    "呈现完整的「前因→发展→高潮→结果」连续剧情，4格之间动作/镜头平滑过渡，保持人物外形服装画风光线一致。"
    "第1格自然承接上一分镜，第4格为下一分镜铺垫。每格只描述该格画面，避免字幕文字。\n"
    "严格要求：只输出 4 行，每行一格的画面提示语，不要编号、不要解释、不要空行。\n\n"
    "【剧本背景参考】\n{script}"
)


def _call_text_llm(messages, api_url, api_key, model, temperature=0.7, timeout=120):
    """调用 OpenAI/DeepSeek 兼容的文本对话接口，返回 (text, error)。
    api_url 可填到根域名（自动补 /chat/completions）或完整端点。"""
    base = (api_url or 'https://api.deepseek.com').rstrip('/')
    url = base if base.endswith('/chat/completions') else base + '/chat/completions'
    body = {'model': model or 'deepseek-v4-flash', 'messages': messages,
            'stream': False, 'temperature': temperature}
    try:
        resp = requests.post(url, json=body,
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            timeout=timeout)
    except Exception as e:
        return None, f'请求失败: {e}'
    if resp.status_code != 200:
        msg = f'HTTP {resp.status_code}'
        try:
            em = (resp.json().get('error') or {})
            if isinstance(em, dict):
                msg = em.get('message') or msg
        except Exception:
            msg = (resp.text or msg)[:160]
        return None, msg
    try:
        j = resp.json()
        content = (j.get('choices') or [{}])[0].get('message', {}).get('content', '')
        content = (content or '').strip()
        if not content:
            return None, '模型返回空内容'
        return content, None
    except Exception as e:
        return None, f'解析失败: {e}'


def _cleanup_image_jobs():
    now = time.time()
    with image_jobs_lock:
        stale = [k for k, v in image_jobs.items() if now - v.get('ts', now) > IMAGE_JOB_TTL]
        for k in stale:
            image_jobs.pop(k, None)


def _run_image_job(task_id, params):
    try:
        images, error = _call_image_api(
            params['prompt'], params['api_url'], params['api_key'],
            params['model'], params['size'], params['quality'], params.get('n', 1))
        with image_jobs_lock:
            job = image_jobs.get(task_id)
            if job is None:
                return
            if images:
                job.update(status='done', images=images, ts=time.time())
            else:
                job.update(status='error', error=error or '未知错误', ts=time.time())
    except Exception as e:
        import traceback; traceback.print_exc()
        with image_jobs_lock:
            job = image_jobs.get(task_id)
            if job is not None:
                job.update(status='error', error=str(e), ts=time.time())

# ==================== Database ====================

def get_db():
    """Get a thread-local database connection."""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    os.makedirs(BASE_DIR, exist_ok=True)
    os.makedirs(MEDIA_DIR, exist_ok=True)
    os.makedirs(IMPORT_DIR, exist_ok=True)
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK(id=1),
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS media_blobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            media_type TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime TEXT NOT NULL,
            data BLOB NOT NULL,
            created_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO settings (id, data) VALUES (1, '{}');
    """)
    conn.commit()
    conn.close()

# ==================== Settings ====================

def load_settings():
    conn = get_db()
    row = conn.execute("SELECT data FROM settings WHERE id=1").fetchone()
    conn.close()
    if row:
        return json.loads(row[0])
    return {}

def save_settings(settings):
    # Merge with existing settings (never lose data)
    existing = load_settings()
    merged = {**existing, **settings}
    conn = get_db()
    conn.execute("UPDATE settings SET data=? WHERE id=1", (json.dumps(merged, ensure_ascii=False),))
    conn.commit()
    conn.close()

# ==================== Projects ====================

def load_index():
    conn = get_db()
    rows = conn.execute("SELECT id, data FROM projects").fetchall()
    conn.close()
    result = []
    for row in rows:
        proj = json.loads(row[1])
        result.append({
            "id": row[0],
            "name": proj.get("name", ""),
            "displayName": proj.get("displayName", ""),
            "createdAt": proj.get("createdAt", 0)
        })
    return result

def load_project(pid):
    conn = get_db()
    row = conn.execute("SELECT data FROM projects WHERE id=?", (pid,)).fetchone()
    conn.close()
    if row:
        return json.loads(row[0])
    return None

def save_project(pid, data):
    conn = get_db()
    conn.execute("INSERT OR REPLACE INTO projects (id, data) VALUES (?, ?)",
                 (pid, json.dumps(data, ensure_ascii=False)))
    conn.commit()
    conn.close()

def delete_project_db(pid):
    conn = get_db()
    conn.execute("DELETE FROM projects WHERE id=?", (pid,))
    conn.commit()
    conn.close()
    # Clean media files
    media_path = os.path.join(MEDIA_DIR, pid)
    if os.path.isdir(media_path):
        shutil.rmtree(media_path, ignore_errors=True)

# ==================== Media ====================

def _content_disposition(filename):
    """生成 Content-Disposition: attachment 头值，兼容中文/特殊字符文件名（RFC 5987）。
    跨应用拖放（剪映等）依赖此头把响应识别为可下载/可拖出的文件。"""
    from urllib.parse import quote
    name = os.path.basename(filename or 'download')
    # ASCII 兜底名（非 ASCII 字符替换为下划线），同时给出 UTF-8 编码的 filename*
    ascii_name = name.encode('ascii', 'replace').decode('ascii').replace('?', '_').replace('"', '_')
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


def save_media_file(pid, media_type, base64_data):
    # Also save as file for direct HTTP serving
    folder = os.path.join(MEDIA_DIR, pid, media_type)
    os.makedirs(folder, exist_ok=True)

    raw = base64_data
    if ',' in raw:
        raw = raw.split(',', 1)[1]
    file_bytes = base64.b64decode(raw)

    ext = '.png' if media_type == 'images' else '.wav'
    mime = 'image/png' if media_type == 'images' else 'audio/wav'
    filename = f"{int(time.time()*1000)}_{random.randint(1000,9999)}{ext}"
    filepath = os.path.join(folder, filename)

    with open(filepath, 'wb') as f:
        f.write(file_bytes)

    # Store BLOB in SQLite for persistence
    try:
        conn = get_db()
        conn.execute(
            "INSERT INTO media_blobs (project_id, media_type, filename, mime, data, created_at) VALUES (?,?,?,?,?,?)",
            (pid, media_type, filename, mime, file_bytes, int(time.time()*1000))
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[MEDIA] SQLite BLOB 存储失败: {e}")

    return f"media/{pid}/{media_type}/{filename}"

# ==================== Migration from old JSON ====================

def migrate_if_needed():
    old_data = os.path.join(BASE_DIR, "data.json")
    if not os.path.exists(old_data):
        return

    conn = get_db()
    # Check if migration already done
    count = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
    if count > 0:
        conn.close()
        return

    print("[迁移] 从 data.json 迁移到 SQLite...")
    try:
        with open(old_data, 'r', encoding='utf-8') as f:
            old = json.load(f)

        # Migrate settings
        old_settings = old.get('settings', {})
        if old_settings:
            conn.execute("UPDATE settings SET data=? WHERE id=1",
                        (json.dumps(old_settings, ensure_ascii=False),))

        # Migrate projects
        for proj in old.get('projects', []):
            pid = proj.get('id', '')
            if not pid:
                continue
            for key in ['characters', 'props', 'scenes', 'storyboards']:
                if key not in proj:
                    proj[key] = []

            # Migrate base64 images to files
            for key in ['characters', 'props', 'scenes', 'storyboards']:
                for item in proj.get(key, []):
                    for img in item.get('images', []):
                        if img.get('data', '').startswith('data:'):
                            try:
                                rel = save_media_file(pid, 'images', img['data'])
                                img['data'] = rel
                            except Exception as e:
                                print(f"[迁移] 图片失败: {e}")
                    for aud in item.get('audios', []):
                        if aud.get('data', '').startswith('data:'):
                            try:
                                rel = save_media_file(pid, 'audio', aud['data'])
                                aud['data'] = rel
                            except Exception as e:
                                print(f"[迁移] 音频失败: {e}")

            conn.execute("INSERT OR REPLACE INTO projects (id, data) VALUES (?, ?)",
                        (pid, json.dumps(proj, ensure_ascii=False)))
            print(f"[迁移] 项目: {proj.get('name', pid)}")

        conn.commit()
        # Rename old file to prevent re-migration
        os.rename(old_data, old_data + ".bak")
        print("[迁移] 完成!")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[迁移] 失败: {e}")
    finally:
        conn.close()

# ==================== ComfyUI helpers ====================

def _comfyui_candidates():
    """ComfyUI 根目录候选（环境变量 COMFYUI_DIR 优先；含已知 Windows 路径与跨平台常见位置）。"""
    cands = []
    env = os.environ.get("COMFYUI_DIR", "").strip()
    if env:
        cands.append(env)
    cands += [
        "F:\\Desktop\\ComfyUI\\ComfyUI_Mie_2026_V8.0_Base\\ComfyUI",
        os.path.join(os.path.dirname(__file__), "..", "..", "ComfyUI"),
        os.path.join(os.path.dirname(__file__), "..", "..", "ComfyUI_windows_portable", "ComfyUI"),
        os.path.expanduser("~\\ComfyUI"),
        os.path.expanduser("~/ComfyUI"),
        os.path.expanduser("~/Downloads/ComfyUI"),
        os.path.expanduser("~/Documents/ComfyUI"),
        os.path.expanduser("~/Desktop/ComfyUI"),
    ]
    return cands

def find_comfyui_dirs():
    global COMFYUI_BASE
    for d in _comfyui_candidates():
        if d and os.path.isdir(d):
            COMFYUI_BASE = d
            output_dir = os.path.join(d, "output")
            temp_dir = os.path.join(d, "temp")
            return {"output": output_dir if os.path.isdir(output_dir) else None, "temp": temp_dir if os.path.isdir(temp_dir) else None}
    return {"output": None, "temp": None}

def run_tts_worker():
    while True:
        try:
            task = tts_queue.get(timeout=5)
        except queue.Empty:
            continue
        try:
            with tts_busy:
                result = generate_tts_sync(task)
                tts_results[task['id']] = result
        except Exception as e:
            tts_results[task['id']] = {'success': False, 'error': str(e)}

def generate_tts_sync(task):
    character_name = task['character_name']
    voice_desc = task['voice_desc']
    tts_text = task['text']
    # 语音设计工作流：'qwen3'(默认，TDQwen3TTSVoiceDesign) | 'voxcpm'(RunningHub_VoxCPM_Generate)
    design_wf = task.get('voice_design_workflow') or 'qwen3'
    wf_path = VOICE_DESIGN_WORKFLOWS.get(design_wf, TTS_WORKFLOW_PATH)
    if not os.path.exists(wf_path):
        return {'success': False, 'error': f'未找到语音设计工作流文件: {os.path.basename(wf_path)}'}

    with open(wf_path, 'r', encoding='utf-8') as f:
        workflow = json.load(f)

    rseed = random.randint(1, 2**31)
    if design_wf == 'voxcpm':
        # VoxCPM2：control_instruction(音色描述) 与 text(朗读内容) 分别来自两个 CR Prompt Text 节点，
        # 通过 _meta.title 区分（语言设计 = 音色描述；实际内容 = 朗读文本）；seed 写在 Generate 节点。
        for node_id, node in workflow.items():
            ct = node.get('class_type')
            if ct == 'CR Prompt Text':
                title = (node.get('_meta', {}) or {}).get('title', '')
                if '设计' in title:
                    node['inputs']['prompt'] = voice_desc or "标准普通话，自然流畅"
                else:
                    node['inputs']['prompt'] = tts_text
            elif ct == 'RunningHub_VoxCPM_Generate':
                node['inputs']['seed'] = rseed
    else:
        # Qwen3-TD-TTS 语音设计：单节点 TDQwen3TTSVoiceDesign
        for node_id, node in workflow.items():
            if node.get('class_type') == 'TDQwen3TTSVoiceDesign':
                node['inputs']['text'] = tts_text
                node['inputs']['instruct'] = voice_desc or "标准普通话，自然流畅"
                node['inputs']['seed'] = rseed
                break

    dirs = find_comfyui_dirs()
    before_files = set()
    if dirs.get('temp'):
        try: before_files = set(os.listdir(dirs['temp']))
        except: pass

    resp = requests.post(f"{COMFYUI_URL}/api/prompt", json={"prompt": workflow}, timeout=10)
    if resp.status_code != 200:
        return {'success': False, 'error': f'ComfyUI请求失败: {resp.status_code}'}

    prompt_id = resp.json()['prompt_id']

    audio_filename = None
    for attempt in range(150):
        time.sleep(2)
        try:
            hr = requests.get(f"{COMFYUI_URL}/api/history/{prompt_id}", timeout=10)
            if hr.status_code != 200: continue
            history = hr.json()
            if prompt_id not in history: continue
            outputs = history[prompt_id].get('outputs', {})
            for nid, odata in outputs.items():
                for key in ['audio', 'gifs', 'images']:
                    if key in odata:
                        for item in odata[key]:
                            audio_filename = item.get('filename', '')
                            break
                if audio_filename: break
            break
        except: continue

    if not audio_filename and dirs.get('temp'):
        try:
            now = set(os.listdir(dirs['temp']))
            new = now - before_files
            cands = sorted([f for f in new if f.endswith(('.wav','.mp3','.flac','.ogg'))],
                           key=lambda x: os.path.getmtime(os.path.join(dirs['temp'], x)), reverse=True)
            if cands: audio_filename = cands[0]
        except: pass

    if not audio_filename:
        return {'success': False, 'error': '未找到音频文件'}

    fpath = os.path.join(dirs['temp'], audio_filename)
    with open(fpath, 'rb') as f:
        audio_bytes = f.read()

    b64 = base64.b64encode(audio_bytes).decode('utf-8')
    return {'success': True, 'audio_base64': b64, 'mime': 'audio/wav'}


# ==================== ComfyUI 通用上传 / 取结果 ====================

def comfy_upload_file(raw_bytes, filename, subfolder=""):
    """把二进制文件上传到 ComfyUI 的 input 目录，返回服务端实际文件名。
    ComfyUI 的 /api/upload/image 接口同样接受音频等任意文件。"""
    files = {'image': (filename, raw_bytes, 'application/octet-stream')}
    data = {'type': 'input', 'overwrite': 'true'}
    if subfolder:
        data['subfolder'] = subfolder
    r = requests.post(f"{COMFYUI_URL}/api/upload/image", files=files, data=data, timeout=60)
    if r.status_code != 200:
        raise RuntimeError(f'ComfyUI 上传失败: {r.status_code}')
    j = r.json()
    name = j.get('name', filename)
    sf = j.get('subfolder', '')
    return (f"{sf}/{name}" if sf else name)


def comfy_cleanup_input_files(names):
    """用完即删：清理本次上传到 ComfyUI input 目录的临时图。

    backend 与 ComfyUI 同机，input 目录即 COMFYUI_BASE/input。
    仅删传入的文件名（如 sbimg_*.png），删不到/无目录则静默跳过，绝不影响主流程。
    names: comfy_upload_file 返回的文件名列表（可能含 subfolder 前缀 "sub/name"）。
    """
    try:
        if not names:
            return
        if not COMFYUI_BASE:
            try:
                find_comfyui_dirs()
            except Exception:
                pass
        if not COMFYUI_BASE:
            return
        input_dir = os.path.join(COMFYUI_BASE, "input")
        if not os.path.isdir(input_dir):
            return
        for nm in names:
            if not nm:
                continue
            # 仅允许删 input 目录内、规范化后仍在该目录下的文件，防止路径穿越
            p = os.path.normpath(os.path.join(input_dir, nm))
            if os.path.commonpath([input_dir, p]) != input_dir:
                continue
            try:
                if os.path.isfile(p):
                    os.remove(p)
            except Exception:
                pass
    except Exception:
        pass


class JobCancelled(Exception):
    """任务被用户主动打断。"""
    pass


def comfy_interrupt():
    """请求 ComfyUI 中断当前正在执行的任务。"""
    try:
        requests.post(f"{COMFYUI_URL}/api/interrupt", timeout=10)
    except Exception:
        pass


def comfy_run_and_wait(workflow, want_kinds=('gifs', 'images', 'audio'), max_wait=600,
                       on_prompt_id=None, should_cancel=None):
    """提交 workflow 到 ComfyUI 并轮询 history，返回 (outputs_dict, prompt_id)。

    on_prompt_id(prompt_id): 拿到 prompt_id 后回调（用于把它记到任务上，便于取消）。
    should_cancel(): 返回 True 时，调用 ComfyUI interrupt 真实打断并抛出 JobCancelled。
    """
    # 提交前若已请求取消，直接放弃
    if should_cancel and should_cancel():
        raise JobCancelled()
    resp = requests.post(f"{COMFYUI_URL}/api/prompt", json={"prompt": workflow}, timeout=15)
    if resp.status_code != 200:
        raise RuntimeError(f'ComfyUI 请求失败: {resp.status_code} {resp.text[:200]}')
    prompt_id = resp.json()['prompt_id']
    if on_prompt_id:
        try: on_prompt_id(prompt_id)
        except Exception: pass
    found = {}
    for _ in range(max_wait // 2):
        # 轮询前检查取消：真实打断 ComfyUI 执行
        if should_cancel and should_cancel():
            comfy_interrupt()
            raise JobCancelled()
        time.sleep(2)
        try:
            hr = requests.get(f"{COMFYUI_URL}/api/history/{prompt_id}", timeout=10)
            if hr.status_code != 200:
                continue
            history = hr.json()
            if prompt_id not in history:
                continue
            entry = history[prompt_id]
            status = entry.get('status', {}) or {}
            status_str = status.get('status_str', '')
            completed = status.get('completed', False)
            # 工作流执行报错：直接抛出节点报错信息（避免误报“未产出音频”）
            if status_str == 'error':
                msgs = []
                for m in status.get('messages', []) or []:
                    if isinstance(m, (list, tuple)) and len(m) >= 2 and m[0] in ('execution_error', 'execution_interrupted'):
                        d = m[1] or {}
                        em = d.get('exception_message') or d.get('exception_type') or ''
                        node = d.get('node_type') or d.get('node_id') or ''
                        if em:
                            msgs.append(f'{node}: {em}' if node else em)
                raise RuntimeError('ComfyUI 工作流执行失败：' + ('; '.join(msgs) if msgs else status_str))
            # 必须等到任务真正完成（completed=True 或已落出 outputs）才收集产物，
            # 否则 history 刚排队就返回会误判为“无产出”。
            outputs = entry.get('outputs', {})
            if not completed and not outputs:
                continue
            for nid, odata in outputs.items():
                for key in want_kinds:
                    if key in odata and odata[key]:
                        found[key] = odata[key]
            # 已完成但想要的 kind 还没出现，再多等一轮（PreviewAudio 落盘可能稍晚）
            if completed or found:
                return found, prompt_id
        except RuntimeError:
            raise
        except Exception:
            continue
    return found, prompt_id


def comfy_fetch_view(filename, subfolder='', ftype='output'):
    """通过 /api/view 取回 ComfyUI 产物的二进制内容。"""
    params = {'filename': filename, 'type': ftype, 'subfolder': subfolder}
    r = requests.get(f"{COMFYUI_URL}/api/view", params=params, timeout=120)
    if r.status_code == 200:
        return r.content
    return None


def comfy_output_abspath(filename, subfolder='', ftype='output'):
    """计算 ComfyUI 产物在本机磁盘上的绝对路径（backend 与 ComfyUI 同机时可用）。
    用于「索引到生成目录、不复制」的视频历史：前端通过 /api/video_file?path= 直接流式读取。

    多重兜底，尽量拿到带子文件夹的真实路径：
      ① 优先按 COMFYUI_BASE/<type>/<subfolder>/<filename> 直接拼接；
      ② COMFYUI_BASE 未探测到时，遍历候选根目录重试；
      ③ subfolder 用反斜杠/正斜杠混写时做归一化；
      ④ 最后在 output 目录树里递归查找同名文件兜底（应对子文件夹未回传/延迟落盘）。
    取不到则返回空串。"""
    if not filename:
        return ''
    sub = (ftype or 'output')   # output / temp / input
    fname = os.path.basename(filename)   # 防止 filename 里自带路径
    subnorm = (subfolder or '').replace('\\', '/').strip('/')

    # 候选根目录：已探测到的 COMFYUI_BASE 优先，否则遍历所有候选
    bases = []
    if COMFYUI_BASE:
        bases.append(COMFYUI_BASE)
    for d in _comfyui_candidates():
        if d and d not in bases and os.path.isdir(d):
            bases.append(d)

    for root in bases:
        typedir = os.path.join(root, sub)
        # ① 标准拼接（含子文件夹）
        p = os.path.join(typedir, *subnorm.split('/'), fname) if subnorm else os.path.join(typedir, fname)
        try:
            if os.path.isfile(p):
                return p
        except Exception:
            pass
        # ② 直接放在 type 目录下（无子文件夹）
        p2 = os.path.join(typedir, fname)
        try:
            if os.path.isfile(p2):
                return p2
        except Exception:
            pass
        # ③ 递归兜底：在 type 目录树里找同名文件（应对子文件夹未回传/大小写差异）
        try:
            if os.path.isdir(typedir):
                for dirpath, _dirs, files in os.walk(typedir):
                    if fname in files:
                        return os.path.join(dirpath, fname)
        except Exception:
            pass
    return ''


def run_tts_clone_sync(params):
    """语音克隆：上传参考音频 → 运行所选克隆工作流 → 返回 base64 音频。
    params: { ref_audio_b64, ref_audio_mime, text, ref_text(语气/参考文本),
              workflow: 'vocpm'(默认,VoxCPM) | 'qwen3'(Qwen3-TD-TTS) | 'indextts'(IndexTTS-2,带情感),
              emotions: {Happy/Angry/Sad/Fear/Hate/Low/Surprise/Neutral: 0~1.4}(仅 indextts) }"""
    wf_key = (params.get('workflow') or 'vocpm').strip().lower()
    wf_path = TTS_CLONE_WORKFLOWS.get(wf_key, TTS_CLONE_WORKFLOW_PATH)
    if not os.path.exists(wf_path):
        return {'success': False, 'error': f'未找到语音克隆工作流文件（{wf_key}）'}
    with open(wf_path, 'r', encoding='utf-8') as f:
        workflow = json.load(f)

    # 1. 上传参考音频到 ComfyUI input
    ref_b64 = params.get('ref_audio_b64', '')
    if not ref_b64:
        return {'success': False, 'error': '缺少参考音频（请先为该角色生成/上传音色）'}
    mime = params.get('ref_audio_mime', 'audio/wav')
    ext = 'wav'
    if 'mp3' in mime: ext = 'mp3'
    elif 'flac' in mime: ext = 'flac'
    elif 'ogg' in mime: ext = 'ogg'
    try:
        raw = base64.b64decode(ref_b64)
    except Exception:
        return {'success': False, 'error': '参考音频解码失败'}
    fname = f"sbref_{int(time.time()*1000)}_{random.randint(100,999)}.{ext}"
    try:
        server_name = comfy_upload_file(raw, fname)
    except Exception as e:
        return {'success': False, 'error': f'参考音频上传失败: {e}'}

    # 2. 注入工作流参数（VoxCPM 语音克隆）
    rseed = random.randint(1, 2**31)
    for nid, node in workflow.items():
        ct = node.get('class_type')
        if ct == 'LoadAudio':
            node['inputs']['audio'] = server_name
            node['inputs'].pop('audioUI', None)
        elif ct == 'voxcpm_nkxx_unified_generator':
            # VoxCPM：台词写入 target_text；语气（tone）写入 control_instruction（可控指令）
            # 没有语气时置空 control_instruction（不保留工作流里的示例值）
            node['inputs']['target_text'] = params.get('text', '')
            node['inputs']['control_instruction'] = (params.get('ref_text') or '').strip()
            if 'seed' in node['inputs']:
                node['inputs']['seed'] = rseed
        elif ct == 'TDQwen3TTSVoiceClone':
            # Qwen3-TD-TTS：台词写入 text；语气/参考文本写入 ref_text（可空）
            node['inputs']['text'] = params.get('text', '')
            node['inputs']['ref_text'] = (params.get('ref_text') or '').strip()
            if 'seed' in node['inputs']:
                node['inputs']['seed'] = rseed
        elif ct == 'easy indexTTSGenerate':
            # IndexTTS-2：台词写入 text
            node['inputs']['text'] = params.get('text', '')
            if 'seed' in node['inputs']:
                node['inputs']['seed'] = rseed
        elif ct == 'easy indexTTSEmotionVector':
            # IndexTTS-2：8 维情感分数（0~1.4）。前端传 emotions={Happy:..,Angry:..,..}，
            # 缺省置 0；参考音色由通用 LoadAudio 分支注入（本节点 reference_audio 引用 LoadAudio 输出）。
            emo = params.get('emotions') or {}
            for k in INDEXTTS_EMOTION_KEYS:
                try:
                    v = float(emo.get(k, 0) or 0)
                except (TypeError, ValueError):
                    v = 0.0
                v = max(INDEXTTS_EMOTION_MIN, min(INDEXTTS_EMOTION_MAX, v))
                node['inputs'][k] = v
            # 有显式情感时不使用随机情感
            if 'use_random' in node['inputs']:
                node['inputs']['use_random'] = False

    # 3. 运行并取回音频
    try:
        found, _ = comfy_run_and_wait(workflow, want_kinds=('audio', 'gifs', 'images'))
    except Exception as e:
        return {'success': False, 'error': str(e)}
    item = None
    for key in ('audio', 'gifs', 'images'):
        if found.get(key):
            item = found[key][0]; break
    if not item:
        return {'success': False, 'error': '克隆未产出音频（工作流已结束但无音频输出，请检查 PreviewAudio 节点）'}
    fn = item.get('filename', '')
    sf = item.get('subfolder', '')
    # 1) 先按 item 自带 type 取（PreviewAudio 通常是 temp），失败再依次试 temp/output
    content = None
    for ft in [item.get('type', 'temp'), 'temp', 'output']:
        content = comfy_fetch_view(fn, sf, ft)
        if content:
            break
    # 2) 仍失败：直接读本地 ComfyUI 的 temp / output 目录
    if not content and fn:
        dirs = find_comfyui_dirs()
        for dkey in ('temp', 'output'):
            d = dirs.get(dkey)
            if not d:
                continue
            fp = os.path.join(d, sf, fn) if sf else os.path.join(d, fn)
            if os.path.exists(fp):
                with open(fp, 'rb') as f:
                    content = f.read()
                break
    if not content:
        return {'success': False, 'error': '无法取回克隆音频文件（文件名 %s）' % (fn or '?')}
    return {'success': True, 'audio_base64': base64.b64encode(content).decode('utf-8'), 'mime': 'audio/wav'}


def _convert_ui_workflow_to_api(ui_wf):
    """尝试把 ComfyUI 网页版「完整工作流」格式转换为 /api/prompt 需要的 API 格式。

    网页版格式的 widgets_values 仅是「纯值数组」，与各参数名的对应关系依赖每个节点
    类型的 widget 定义顺序（JSON 中未完整保存该映射）。强行按顺序映射会造成参数错位，
    比直接报错更危险。因此这里不做易错的自动转换，返回 None，由上层给出明确的
    「请导出 API 格式」提示。（保留此函数便于未来在拿到节点 schema 后实现可靠转换。）
    """
    return None


def _parse_video_resolution(resolution):
    """把前端的视频分辨率字符串解析为 (width, height, label)。
    入参形如 "1280 x 720 (16:9)" / "480 x 832 (9:16)"，宽高会向下取整到 32 的倍数
    （LTXV/LTXDirector 要求边长可被 32 整除，否则报错或被回退）。
    解析失败时回退默认 1280x720。返回的 label 用于写回时间轴 resolution 字段。"""
    default_w, default_h = 1280, 720
    s = (resolution or '').strip()
    m = re.match(r'^\s*(\d+)\s*[x×]\s*(\d+)', s)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
    else:
        w, h = default_w, default_h
    # 对齐到 32 的倍数（最小 32），避免 ComfyUI 边长非法
    w = max(32, (w // 32) * 32)
    h = max(32, (h // 32) * 32)
    # label 优先沿用原字符串（含比例标注），便于乱神版时间轴 resolution 完全一致
    label = s if m else f'{default_w} x {default_h} (16:9)'
    return w, h, label


def run_director_singularity_sync(params, task_id=None):
    """Singularity（乱神版 V3）导演台视频生成。

    与旧 LTXDirector 不同，本工作流通过 `easy timelineEditor` 节点的 timeline_data 驱动，
    格式为：
      {
        "tracks": [
          { "type": "maintain", "segments": [
              { "start_frame", "end_frame",
                "content": { "text": <local_prompt 含中文对白>,
                             "images": [{ "source_type":"url", "url":..., "file_name":...,
                                          "start_frame":0, "end_frame": <段长> }],
                             "type": "flf" } }
          ]},
          { "type": "audio", "segments": [] }
        ],
        "total_length": <总帧>, "frame_rate": <fps>
      }
    图像上传到 ComfyUI input 后用 source_type="input" + file_path 本地引用（不要用 url，
    否则节点会经 urllib + 本机代理下载 127.0.0.1 失败，导致图丢失、PromptRelay 回退 704x480）；
    音频默认不走编辑器（节点99=false），由模型按 text 中的对白描述生成语音。

    入参同新版双轨：imageSegments[{image_b64, prompt, start, length, transition, transition_dur}]、
    total_frames、global_prompt、epsilon、fps 等（audioSegments 在本工作流中不直接使用）。
    """
    if not os.path.exists(DIRECTOR_SINGULARITY_WORKFLOW_PATH):
        return {'success': False, 'error': '未找到 Singularity 导演台工作流文件'}
    with open(DIRECTOR_SINGULARITY_WORKFLOW_PATH, 'r', encoding='utf-8') as f:
        workflow = json.load(f)

    fps = int(params.get('fps', 30))
    img_segs = sorted(params.get('imageSegments') or [], key=lambda s: int(s.get('start', 0)))
    if not img_segs:
        # 兼容旧版成对格式
        segs = params.get('segments') or []
        img_segs = [{'image_b64': s.get('image_b64', ''), 'prompt': s.get('prompt', ''),
                     'start': 0, 'length': int(s.get('length', 90))} for s in segs]
    if not img_segs:
        return {'success': False, 'error': '缺少图像段'}

    # === 先按 group_id 把「连续的同组图像段」聚合成块（block）===
    # 乱神 easy timelineEditor 的一个 maintain 段支持挂多张图（content.images 数组，即「多帧」）：
    # 同一四宫格组（前端传来的 group_id 相同）的多张图，合并到「一个段」里，按段长均分 start/end_frame，
    # 让模型把它们当成这一镜的连续关键帧来插帧（一个 local prompt 配多图），而不是拆成多段。
    # 无 group_id 或单图段则各自成块，行为与原来逐段一致。转场跟随「块」的最后一段。
    blocks = []  # 每个元素: {segs:[seg,...]}（同组连续多段）
    for seg in img_segs:
        # 跳过空段（无图无词）
        if not seg.get('image_b64') and not (seg.get('prompt', '') or '').strip():
            continue
        gid = str(seg.get('group_id') or '').strip()
        if blocks and gid and str(blocks[-1].get('group_id') or '') == gid:
            blocks[-1]['segs'].append(seg)
        else:
            blocks.append({'group_id': gid, 'segs': [seg]})

    # 组装 easy timelineEditor 的 maintain 轨道（按 cursor 顺序紧贴排布，含转场段）
    main_segments = []
    cursor = 0
    uploaded_names = []   # 本次上传到 input 的临时图，结束后清理
    for bi, block in enumerate(blocks):
        segs = block['segs']
        # 块时长 = 块内各段时长之和；块的 local prompt 取块内第一段（同组已共享同一 prompt）
        block_len = sum(max(1, int(s.get('length', 90))) for s in segs)
        first_seg = segs[0]
        seg_text = (first_seg.get('prompt', '') or '').strip()
        if seg_text and '无字幕' not in seg_text:
            seg_text = seg_text + '，无字幕'

        # 上传块内每张图，按「在块内的累计帧位」均分 start/end_frame（多帧关键帧）
        images = []
        acc = 0
        for k, s in enumerate(segs):
            s_len = max(1, int(s.get('length', 90)))
            if s.get('image_b64'):
                try:
                    raw = base64.b64decode(s['image_b64'])
                    img_name = comfy_upload_file(raw, f"sbimg_{int(time.time()*1000)}_{bi}_{k}.png")
                    uploaded_names.append(img_name)
                except Exception as e:
                    comfy_cleanup_input_files(uploaded_names)
                    return {'success': False, 'error': f'第{bi+1}块第{k+1}张图像上传失败: {e}'}
                # 关键：图已上传到 ComfyUI input 目录，用 source_type="input" + file_path 本地读取，
                # 不要用 url（easy timelineEditor 的 load_image_tensor 解析 url 会走 urllib，
                # 受本机代理影响访问 127.0.0.1:8188 失败 → 图丢失 → PromptRelay 回退 704x480）。
                # 单图块 → 整段一张图（start=0,end=块长）；多图块 → 每张图均分块时长，做多帧关键帧。
                if len(segs) > 1:
                    images.append({
                        'source_type': 'input', 'file_path': img_name, 'file_name': img_name,
                        'start_frame': acc, 'end_frame': acc + s_len,
                    })
                else:
                    images.append({
                        'source_type': 'input', 'file_path': img_name, 'file_name': img_name,
                        'start_frame': 0, 'end_frame': block_len,
                    })
            acc += s_len

        content = {
            'text': seg_text,
            'images': images,
            'type': 'flf',
        }
        main_segments.append({
            'id': f"seg{bi}-{random.randint(100000,999999)}",
            'start_frame': cursor,
            'end_frame': cursor + block_len,
            'content': content,
            'color': 'var(--secondary)',
        })
        cursor += block_len

        # 相邻块之间插入转场段（无图、纯文本），最后一块不插。转场取块内最后一段的转场设置。
        last_seg = segs[-1]
        trans_text = str(last_seg.get('transition', '') or '').strip()
        trans_frames = int(round(float(last_seg.get('transition_dur', 0) or 0) * fps))
        if bi < len(blocks) - 1 and trans_text and trans_frames > 0:
            trans_prompt = trans_text if '无字幕' in trans_text else (trans_text + '，无字幕')
            main_segments.append({
                'id': f"trans{bi}-{random.randint(100000,999999)}",
                'start_frame': cursor,
                'end_frame': cursor + trans_frames,
                'content': {'text': trans_prompt, 'images': [], 'type': 'flf'},
                'color': 'var(--secondary)',
            })
            cursor += trans_frames

    # total_length 取 segments 铺满的实际帧数（cursor）。
    total_frames = cursor if cursor > 0 else max(int(params.get('total_frames') or 0), 1)

    # ★ 结尾乱码/花屏根因修复：LTX latent 时序按 8 帧一组压缩，合法总帧数必须是 8k+1
    #   （如 121、201、601…）。若 total 不是 8k+1，VAE 解码时末尾会多出 1~7 帧「不足一个 latent 块」
    #   的悬空帧——这些帧没有任何图像锚点（image_indexes 只钉到各段 start_frame），LTX 在此自由发挥，
    #   解码出一坨乱码/类文字花纹，固定出现在每条视频结尾。
    #   修法：把 total 向上对齐到最近的 8k+1，并把多出的帧并入「最后一个有图的段」——
    #   让最后一镜的图锚点一直延伸到真正的末帧，末尾不再有无锚帧，乱码消失，且剧情画面完整保留。
    aligned = ((total_frames - 1 + 7) // 8) * 8 + 1
    if aligned != total_frames:
        pad = aligned - total_frames
        # 找最后一个带图的 maintain 段，把它和它的引导图 end_frame 一起延伸 pad 帧
        last_img_seg = None
        for s in main_segments:
            if s.get('content', {}).get('images'):
                last_img_seg = s
        if last_img_seg is not None:
            last_img_seg['end_frame'] += pad
            for im in last_img_seg['content']['images']:
                im['end_frame'] = im.get('end_frame', 0) + pad
        total_frames = aligned

    timeline_obj = {
        'tracks': [
            {
                'id': f"track-main-{random.randint(100000,999999)}",
                'name': '主轨 1', 'type': 'maintain', 'color': 'var(--secondary)',
                'muted': False, 'locked': False, 'segments': main_segments,
            },
            {
                'id': f"track-audio-{random.randint(100000,999999)}",
                'name': '音频轨 1', 'type': 'audio', 'color': '#34d399',
                'muted': False, 'locked': False, 'segments': [],
            },
        ],
        'total_length': total_frames,
        'frame_rate': fps,
    }
    timeline_data = json.dumps(timeline_obj, ensure_ascii=False)

    # 注入工作流：仅写 easy timelineEditor 的 timeline_data；其余（global_prompt、epsilon、
    # Stage 种子、Using Editor Audio 等）全部沿用工作流 JSON 原值，最大程度对齐 ComfyUI 图形界面，
    # 便于排查末尾异常画面。
    # 注：原先还会注入 global_prompt 与随机化 Stage 种子，现按需求一并去掉。
    # 生成视频分辨率：写入 easy timelineEditor 的 resolution 字段（格式「宽 x 高 (比例)」），
    # 该节点据此决定时间轴输出尺寸，下游 EmptyLTXVLatentVideo 自动跟随。
    _vw, _vh, _vres_label = _parse_video_resolution(params.get('resolution'))
    for nid, node in workflow.items():
        ct = node.get('class_type')
        if ct == 'easy timelineEditor':
            node['inputs']['timeline_data'] = timeline_data
            node['inputs']['resolution'] = _vres_label
    print(f"[Singularity] resolution={_vres_label} ({_vw}x{_vh})")

    # 注：原先这里有一段对 LTX2SamplingPreviewOverride（采样实时预览节点）的剪枝逻辑——
    # 因后端经 /api/prompt 提交、无前端会话，该节点推预览会崩。现工作流已在 ComfyUI 里
    # 用 Ctrl+B（bypass）摘掉该节点并重新导出，JSON 中已不含此节点，故剪枝代码已删除。
    # 若将来换回带该节点的工作流，请在 ComfyUI 里 bypass 后再导出，不要在后端硬剪（易错接上游导致尾部花屏）。

    # === 临时排查：导出最终提交给 ComfyUI 的完整 workflow（注入 timeline_data 之后的真实入参）===
    # 排查完末尾异常画面后可删除本段。
    try:
        _dbg_dir = os.path.join(os.path.dirname(__file__), "..", "workflow-api")
        _dbg_path = os.path.join(_dbg_dir, "_debug_singularity_submit.json")
        with open(_dbg_path, 'w', encoding='utf-8') as _f:
            json.dump(workflow, _f, ensure_ascii=False, indent=2)
        print(f"[Singularity][debug] 已导出最终提交 workflow → {os.path.abspath(_dbg_path)}")
    except Exception as _e:
        print(f"[Singularity][debug] 导出失败（忽略）: {_e}")
    # === 临时排查结束 ===

    try:
        try:
            found, _ = comfy_run_and_wait(
                workflow, want_kinds=('gifs', 'images', 'audio'), max_wait=3600,
                on_prompt_id=(lambda pid: _sb_job_set(task_id, prompt_id=pid)) if task_id else None,
                should_cancel=(lambda: _sb_job_cancelled(task_id)) if task_id else None,
            )
        except JobCancelled:
            return {'success': False, 'cancelled': True, 'error': '已打断'}
        except Exception as e:
            return {'success': False, 'error': str(e)}
        item = None
        for key in ('gifs', 'images', 'audio'):
            if found.get(key):
                item = found[key][0]; break
        if not item:
            return {'success': False, 'error': 'Singularity 导演台未产出视频'}
        content = comfy_fetch_view(item.get('filename', ''), item.get('subfolder', ''), item.get('type', 'output'))
        if not content:
            return {'success': False, 'error': '无法取回视频文件'}
        vpath = comfy_output_abspath(item.get('filename', ''), item.get('subfolder', ''), item.get('type', 'output'))
        return {'success': True, 'video_base64': base64.b64encode(content).decode('utf-8'),
                'mime': 'video/mp4', 'frames': total_frames,
                'video_file': vpath, 'video_name': item.get('filename', '')}
    finally:
        # 用完即删：无论成功/失败/取消，都清理本次上传到 input 的临时图
        comfy_cleanup_input_files(uploaded_names)


def run_director_sync(params, task_id=None):
    """导演台视频生成：上传图像/音频 → 组装 timeline_data → 运行 LTXDirector → 返回视频 base64。

    支持两种入参格式：
    A) 新版双轨（推荐，图像/音频各自独立，可自由移位/拉伸/裁剪）:
       {
         imageSegments: [{ image_b64, prompt, start(帧), length(帧) }],
         audioSegments: [{ audio_b64, audio_mime, start(帧), length(帧), trimStart(帧) }],
         total_frames, global_prompt, epsilon, guide_strength, use_custom_audio, fps
       }
    B) 旧版成对（兼容）:
       { segments: [{ image_b64, prompt, length, audio_b64?, audio_mime?, trimStart? }], ... }
    """
    if not os.path.exists(DIRECTOR_WORKFLOW_PATH):
        return {'success': False, 'error': '未找到导演台工作流文件'}
    with open(DIRECTOR_WORKFLOW_PATH, 'r', encoding='utf-8') as f:
        workflow = json.load(f)

    # 格式校验：/api/prompt 只接受 API 格式（扁平 {节点id:{class_type,inputs}}）。
    # 若误存成 ComfyUI 网页版「完整工作流」格式（含 nodes/links 数组、顶层无 class_type），
    # 这里尝试自动转换；转换失败则明确报错，避免把错误格式发给 ComfyUI 导致「没反应」。
    if isinstance(workflow, dict) and 'nodes' in workflow and isinstance(workflow.get('nodes'), list):
        converted = _convert_ui_workflow_to_api(workflow)
        if converted is None:
            return {'success': False, 'error': (
                '导演台工作流是 ComfyUI「网页版完整格式」（含 nodes/links），'
                '而后端需要「API 格式」。请在 ComfyUI 里用「导出(API)/Save (API Format)」'
                '重新导出并覆盖 workflow-api/AI代码侠土豆-LTX2.3导演台工作流.json')}
        workflow = converted

    fps = int(params.get('fps', 30))
    timeline_segments = []
    audio_segments = []
    local_prompts = []
    seg_lengths = []

    img_segs = params.get('imageSegments')
    aud_segs = params.get('audioSegments')

    if img_segs is not None or aud_segs is not None:
        # ---------- A) 新版双轨格式 ----------
        img_segs = sorted(img_segs or [], key=lambda s: int(s.get('start', 0)))
        if not img_segs:
            return {'success': False, 'error': '缺少图像段'}

        # 转场支持（附着式）：在相邻两个图像段之间，可自动插入一个「无图的纯文本转场段」。
        #   该段不带 imageFile（节点不会把它当引导图，只当一段过渡 prompt），
        #   时长 = transition_dur 秒（前端每段可调，默认 0=不插入）。
        #   因为插入转场段会把后续内容整体后移，这里用 cursor 重排所有段的 start，
        #   并用 shift_for（按原始帧累计的插入偏移）平移音频段，保证图音对齐。
        cursor = 0
        # 记录「原始帧位置 -> 累计已插入的转场帧」断点，用于音频对齐
        shift_points = []   # [(orig_frame_after, extra_frames_total)]
        cumulative_shift = 0
        for i, seg in enumerate(img_segs):
            length = int(seg.get('length', 90))
            # 空段跳过：既没有图也没有提示词的段不发给 ComfyUI，
            # 否则 LTXDirector 会报「missing a prompt」。
            if not seg.get('image_b64') and not (seg.get('prompt', '') or '').strip():
                continue
            img_file = ''
            if seg.get('image_b64'):
                try:
                    raw = base64.b64decode(seg['image_b64'])
                    img_file = comfy_upload_file(raw, f"sbimg_{int(time.time()*1000)}_{i}.png")
                except Exception as e:
                    return {'success': False, 'error': f'第{i+1}个图像段上传失败: {e}'}
            timeline_segments.append({
                'id': f'seg{i}_{random.randint(1000,9999)}',
                'start': cursor, 'length': length,
                'prompt': seg.get('prompt', ''),
                'type': 'image',
                'imageFile': img_file,
                'imageB64': f"/api/view?filename={img_file}&type=input&subfolder="
            })
            local_prompts.append(seg.get('prompt', ''))
            seg_lengths.append(str(length))
            orig_end = int(seg.get('start', 0)) + length   # 该图像段在「原始时间轴」的结束帧
            cursor += length

            # 是否在该段后插入转场段（最后一段不插）
            trans_text = str(seg.get('transition', '') or '').strip()
            trans_dur_sec = float(seg.get('transition_dur', 0) or 0)
            trans_frames = int(round(trans_dur_sec * fps))
            if i < len(img_segs) - 1 and trans_text and trans_frames > 0:
                # 镜头语言/转场段：无图，prompt 末尾强调「无字幕」
                trans_prompt = trans_text if '无字幕' in trans_text else (trans_text + '，无字幕')
                timeline_segments.append({
                    'id': f'trans{i}_{random.randint(1000,9999)}',
                    'start': cursor, 'length': trans_frames,
                    'prompt': trans_prompt,
                    'type': 'transition',   # 标记为转场段（无 imageFile，节点不当引导图）
                    'imageFile': '',
                    'imageB64': ''
                })
                local_prompts.append(trans_prompt)
                seg_lengths.append(str(trans_frames))
                cursor += trans_frames
                cumulative_shift += trans_frames
            # 记录此原始结束帧之后，应叠加的总偏移（音频用）
            shift_points.append((orig_end, cumulative_shift))

        def _shift_for(orig_frame):
            """某原始帧位置应整体后移多少帧（= 它之前所有已插入转场段的总帧数）。"""
            extra = 0
            for boundary, total in shift_points:
                if orig_frame >= boundary:
                    extra = total
            return extra

        for j, seg in enumerate(sorted(aud_segs or [], key=lambda s: int(s.get('start', 0)))):
            if not seg.get('audio_b64'):
                continue
            try:
                araw = base64.b64decode(seg['audio_b64'])
                amime = seg.get('audio_mime', 'audio/wav')
                aext = 'mp3' if 'mp3' in amime else ('flac' if 'flac' in amime else 'wav')
                afile = comfy_upload_file(araw, f"sbaud_{int(time.time()*1000)}_{j}.{aext}")
                a_start = int(seg.get('start', 0))
                audio_segments.append({
                    'id': f'aud{j}_{random.randint(1000,9999)}',
                    'type': 'audio',
                    'start': a_start + _shift_for(a_start),   # 跟随转场段顺延，保持图音对齐
                    'length': int(seg.get('length', 90)),
                    'trimStart': int(seg.get('trimStart', 0)),
                    'audioFile': afile, 'fileName': afile
                })
            except Exception as e:
                print(f'[DIRECTOR] 第{j+1}个音频段上传失败: {e}')

        # 总时长：插入转场段后用重排后的 cursor 与音频 end 的最大值。
        #   原 total_frames 不含转场，这里需把转场帧数加进去。
        max_end = max([int(s['start']) + int(s['length']) for s in timeline_segments] +
                      [int(s['start']) + int(s['length']) for s in audio_segments] + [0])
        base_total = int(params.get('total_frames') or 0) + cumulative_shift
        total_frames = max(base_total, max_end)
    else:
        # ---------- B) 旧版成对格式（兼容） ----------
        segs = params.get('segments', [])
        if not segs:
            return {'success': False, 'error': '缺少分镜段'}
        cursor = 0
        for i, seg in enumerate(segs):
            length = int(seg.get('length', 90))
            img_file = ''
            if seg.get('image_b64'):
                try:
                    raw = base64.b64decode(seg['image_b64'])
                    img_file = comfy_upload_file(raw, f"sbimg_{int(time.time()*1000)}_{i}.png")
                except Exception as e:
                    return {'success': False, 'error': f'第{i+1}段图像上传失败: {e}'}
            timeline_segments.append({
                'id': f'seg{i}_{random.randint(1000,9999)}',
                'start': cursor, 'length': length,
                'prompt': seg.get('prompt', ''),
                'type': 'image',
                'imageFile': img_file,
                'imageB64': f"/api/view?filename={img_file}&type=input&subfolder="
            })
            if seg.get('audio_b64'):
                try:
                    araw = base64.b64decode(seg['audio_b64'])
                    amime = seg.get('audio_mime', 'audio/wav')
                    aext = 'mp3' if 'mp3' in amime else ('flac' if 'flac' in amime else 'wav')
                    afile = comfy_upload_file(araw, f"sbaud_{int(time.time()*1000)}_{i}.{aext}")
                    audio_segments.append({
                        'id': f'aud{i}_{random.randint(1000,9999)}',
                        'type': 'audio', 'start': cursor, 'length': length,
                        'trimStart': int(seg.get('trimStart', 0)),
                        'audioFile': afile, 'fileName': afile
                    })
                except Exception as e:
                    print(f'[DIRECTOR] 第{i+1}段音频上传失败: {e}')
            local_prompts.append(seg.get('prompt', ''))
            seg_lengths.append(str(length))
            cursor += length
        total_frames = cursor

    timeline_data = json.dumps({'segments': timeline_segments, 'audioSegments': audio_segments}, ensure_ascii=False)

    # 生成视频分辨率：旧导演台无 resolution 字段，解析出宽高写入 LTXDirector 的 custom_width/height
    _vw, _vh, _vres_label = _parse_video_resolution(params.get('resolution'))
    # 注入 LTXDirector 节点（兼容改名后的 LTXDirectorPlus 与原版 LTXDirector）
    for nid, node in workflow.items():
        if node.get('class_type') in ('LTXDirectorPlus', 'LTXDirector'):
            inp = node['inputs']
            inp['global_prompt'] = params.get('global_prompt', '')
            inp['duration_frames'] = total_frames
            inp['duration_seconds'] = round(total_frames / fps, 2)
            inp['timeline_data'] = timeline_data
            # 分辨率（仅在节点本就含该字段时写入，避免给无该参数的节点塞非法 key）
            if 'custom_width' in inp:
                inp['custom_width'] = _vw
            if 'custom_height' in inp:
                inp['custom_height'] = _vh
            print(f"[Director] resolution={_vres_label} -> custom {_vw}x{_vh}")
            # LTXDirector 用竖线 | 分隔各段 local prompt（见节点源码 _encode_relay）
            inp['local_prompts'] = " | ".join((lp or '画面') for lp in local_prompts)
            inp['segment_lengths'] = ",".join(seg_lengths)
            # epsilon：段间过渡软硬度。0.001=硬切（动作易僵），调高到 ~0.3 过渡更自然、运动更连贯。
            inp['epsilon'] = float(params.get('epsilon', 0.3))
            # guide_strength：每段引导图的约束强度。1.0=最大约束，最贴近引导图（动作小但形象稳）。
            #   每段强度钳制到 max_guide_strength（默认 1.0=不额外降低）；如需更自由的运动可在前端调低。
            max_gs = float(params.get('max_guide_strength', 1.0))
            raw_gs = str(params.get('guide_strength', '') or '')
            if raw_gs.strip():
                clamped = []
                for x in raw_gs.split(','):
                    x = x.strip()
                    if not x:
                        continue
                    try:
                        clamped.append(f"{min(float(x), max_gs):.2f}")
                    except ValueError:
                        clamped.append(f"{max_gs:.2f}")
                inp['guide_strength'] = ",".join(clamped) if clamped else f"{max_gs:.2f}"
            else:
                inp['guide_strength'] = f"{max_gs:.2f}"
            inp['use_custom_audio'] = bool(params.get('use_custom_audio', len(audio_segments) > 0))
            break

    try:
        found, _ = comfy_run_and_wait(
            workflow, want_kinds=('gifs', 'images', 'audio'), max_wait=3600,
            on_prompt_id=(lambda pid: _sb_job_set(task_id, prompt_id=pid)) if task_id else None,
            should_cancel=(lambda: _sb_job_cancelled(task_id)) if task_id else None,
        )
    except JobCancelled:
        return {'success': False, 'cancelled': True, 'error': '已打断'}
    except Exception as e:
        return {'success': False, 'error': str(e)}
    item = None
    for key in ('gifs', 'images', 'audio'):
        if found.get(key):
            item = found[key][0]; break
    if not item:
        return {'success': False, 'error': '导演台未产出视频'}
    content = comfy_fetch_view(item.get('filename', ''), item.get('subfolder', ''), item.get('type', 'output'))
    if not content:
        return {'success': False, 'error': '无法取回视频文件'}
    vpath = comfy_output_abspath(item.get('filename', ''), item.get('subfolder', ''), item.get('type', 'output'))
    return {'success': True, 'video_base64': base64.b64encode(content).decode('utf-8'),
            'mime': 'video/mp4', 'frames': total_frames,
            'video_file': vpath, 'video_name': item.get('filename', '')}


def run_director_yusu_sync(params, task_id=None):
    """Yusu 导演台视频生成。

    核心节点 YusuLTXDirector（节点 174）暴露了原生 LTXV 采样链（DualCLIP / SamplerCustomAdvanced /
    CFGGuider / BasicScheduler / 独立音视频 VAE 解码）+ LoRA + 运动轨，相比旧 LTXDirector 黑盒更可控。
    其 timeline_data 与旧 LTXDirector 高度同构：
      { "global_prompt", "segments":[{id,start,length,prompt,type,imageFile,imageB64}],
        "audioSegments":[{id,type,start,length,trimStart,audioFile,fileName}],
        "motionSegments":[], ... }
    因此本 runner 复用旧导演台的段组装逻辑，仅在注入处适配 YusuLTXDirector 的字段差异：
      - global_prompt 内嵌在 timeline_data 内层（本版按需求留空）；
      - motion 运动轨首版留空（use_custom_motion=false, motionSegments=[]）；
      - 分辨率写入 custom_width/height；frame_rate 跟随 fps。

    入参同旧导演台双轨格式：imageSegments / audioSegments / total_frames / epsilon /
    guide_strength / use_custom_audio / fps / resolution。
    """
    if not os.path.exists(DIRECTOR_YUSU_WORKFLOW_PATH):
        return {'success': False, 'error': '未找到 Yusu 导演台工作流文件'}
    with open(DIRECTOR_YUSU_WORKFLOW_PATH, 'r', encoding='utf-8') as f:
        workflow = json.load(f)

    # 兼容误存成 ComfyUI 网页版「完整工作流」格式（含 nodes/links）
    if isinstance(workflow, dict) and 'nodes' in workflow and isinstance(workflow.get('nodes'), list):
        converted = _convert_ui_workflow_to_api(workflow)
        if converted is None:
            return {'success': False, 'error': (
                'Yusu 导演台工作流是 ComfyUI「网页版完整格式」（含 nodes/links），'
                '而后端需要「API 格式」。请在 ComfyUI 里用「导出(API)/Save (API Format)」'
                '重新导出并覆盖 workflow-api/yusu-工作流.json')}
        workflow = converted

    fps = int(params.get('fps', 30))
    timeline_segments = []
    audio_segments = []
    local_prompts = []
    seg_lengths = []

    img_segs = sorted(params.get('imageSegments') or [], key=lambda s: int(s.get('start', 0)))
    aud_segs = params.get('audioSegments') or []
    if not img_segs:
        # 兼容旧版成对格式
        segs = params.get('segments') or []
        img_segs = [{'image_b64': s.get('image_b64', ''), 'prompt': s.get('prompt', ''),
                     'start': 0, 'length': int(s.get('length', 90))} for s in segs]
    if not img_segs:
        return {'success': False, 'error': '缺少图像段'}

    # ---------- 组装图像轨（含转场段），逻辑同旧导演台 ----------
    cursor = 0
    shift_points = []          # [(orig_end_frame, cumulative_shift)] 供音频对齐
    cumulative_shift = 0
    uploaded_names = []        # 本次上传到 input 的临时文件，结束后清理
    for i, seg in enumerate(img_segs):
        length = int(seg.get('length', 90))
        # 空段跳过：既没有图也没有提示词的段不发给 ComfyUI，否则 director 报「missing a prompt」
        if not seg.get('image_b64') and not (seg.get('prompt', '') or '').strip():
            continue
        img_file = ''
        if seg.get('image_b64'):
            try:
                raw = base64.b64decode(seg['image_b64'])
                img_file = comfy_upload_file(raw, f"sbimg_{int(time.time()*1000)}_{i}.png")
                uploaded_names.append(img_file)
            except Exception as e:
                comfy_cleanup_input_files(uploaded_names)
                return {'success': False, 'error': f'第{i+1}个图像段上传失败: {e}'}
        timeline_segments.append({
            'id': f'seg{i}_{random.randint(1000,9999)}',
            'start': cursor, 'length': length,
            'prompt': seg.get('prompt', ''),
            'type': 'image',
            'imageFile': img_file,
            'imageB64': f"/api/view?filename={img_file}&type=input&subfolder=",
            'isEndFrame': False,
        })
        local_prompts.append(seg.get('prompt', ''))
        seg_lengths.append(str(length))
        orig_end = int(seg.get('start', 0)) + length
        cursor += length

        # 相邻段之间插入转场段（无图、纯文本），最后一段不插
        trans_text = str(seg.get('transition', '') or '').strip()
        trans_frames = int(round(float(seg.get('transition_dur', 0) or 0) * fps))
        if i < len(img_segs) - 1 and trans_text and trans_frames > 0:
            trans_prompt = trans_text if '无字幕' in trans_text else (trans_text + '，无字幕')
            timeline_segments.append({
                'id': f'trans{i}_{random.randint(1000,9999)}',
                'start': cursor, 'length': trans_frames,
                'prompt': trans_prompt,
                'type': 'transition',
                'imageFile': '',
                'imageB64': '',
                'isEndFrame': False,
            })
            local_prompts.append(trans_prompt)
            seg_lengths.append(str(trans_frames))
            cursor += trans_frames
            cumulative_shift += trans_frames
        shift_points.append((orig_end, cumulative_shift))

    def _shift_for(orig_frame):
        extra = 0
        for boundary, total in shift_points:
            if orig_frame >= boundary:
                extra = total
        return extra

    # ---------- 组装音频轨（接入时间轴上传的自定义配音），逻辑同旧导演台 ----------
    for j, seg in enumerate(sorted(aud_segs, key=lambda s: int(s.get('start', 0)))):
        if not seg.get('audio_b64'):
            continue
        try:
            araw = base64.b64decode(seg['audio_b64'])
            amime = seg.get('audio_mime', 'audio/wav')
            aext = 'mp3' if 'mp3' in amime else ('flac' if 'flac' in amime else 'wav')
            afile = comfy_upload_file(araw, f"sbaud_{int(time.time()*1000)}_{j}.{aext}")
            uploaded_names.append(afile)
            a_start = int(seg.get('start', 0))
            audio_segments.append({
                'id': f'aud{j}_{random.randint(1000,9999)}',
                'type': 'audio',
                'start': a_start + _shift_for(a_start),   # 跟随转场段顺延，保持图音对齐
                'length': int(seg.get('length', 90)),
                'trimStart': int(seg.get('trimStart', 0)),
                'audioFile': afile, 'fileName': afile,
            })
        except Exception as e:
            print(f'[YUSU] 第{j+1}个音频段上传失败: {e}')

    max_end = max([int(s['start']) + int(s['length']) for s in timeline_segments] +
                  [int(s['start']) + int(s['length']) for s in audio_segments] + [0])
    base_total = int(params.get('total_frames') or 0) + cumulative_shift
    total_frames = max(base_total, max_end, 1)

    # use_custom_audio 跟随是否有音频段（未显式指定时）
    use_custom_audio = params.get('use_custom_audio')
    if use_custom_audio is None:
        use_custom_audio = len(audio_segments) > 0

    # global_prompt 按需求留空；motion 运动轨首版留空
    timeline_obj = {
        'mainTrackEnabled': True,
        'audioTrackEnabled': True,
        'motionTrackEnabled': True,
        'showFilenames': True,
        'overrideAudio': False,
        'inpaint_audio': False,
        'global_prompt': '',
        'retake_global_prompt': '',
        'retakeMode': False,
        'normalStartFrame': 0,
        'normalDurationFrames': total_frames,
        'segments': timeline_segments,
        'motionSegments': [],
        'audioSegments': audio_segments,
    }
    timeline_data = json.dumps(timeline_obj, ensure_ascii=False)

    _vw, _vh, _vres_label = _parse_video_resolution(params.get('resolution'))

    # 注入 YusuLTXDirector 节点
    injected = False
    for nid, node in workflow.items():
        if node.get('class_type') == 'YusuLTXDirector':
            inp = node['inputs']
            inp['timeline_data'] = timeline_data
            inp['local_prompts'] = " | ".join((lp or '画面') for lp in local_prompts)
            inp['segment_lengths'] = ",".join(seg_lengths)
            inp['epsilon'] = float(params.get('epsilon', 0.3))
            # guide_strength：每段引导图约束强度，钳制到 max_guide_strength（默认 1.0）
            max_gs = float(params.get('max_guide_strength', 1.0))
            raw_gs = str(params.get('guide_strength', '') or '')
            if raw_gs.strip():
                clamped = []
                for x in raw_gs.split(','):
                    x = x.strip()
                    if not x:
                        continue
                    try:
                        clamped.append(f"{min(float(x), max_gs):.2f}")
                    except ValueError:
                        clamped.append(f"{max_gs:.2f}")
                inp['guide_strength'] = ",".join(clamped) if clamped else f"{max_gs:.2f}"
            else:
                inp['guide_strength'] = f"{max_gs:.2f}"
            inp['use_custom_audio'] = bool(use_custom_audio)
            inp['use_custom_motion'] = False   # 运动轨首版留空
            inp['frame_rate'] = fps
            # 帧/秒区间字段同步，避免节点用 JSON 里残留的旧值
            inp['start_frame'] = 0
            inp['end_frame'] = total_frames
            inp['duration_frames'] = total_frames
            inp['start_second'] = 0
            inp['duration_seconds'] = round(total_frames / fps, 2)
            # 分辨率：仅当节点本就含该字段时写入
            if 'custom_width' in inp and not isinstance(inp.get('custom_width'), list):
                inp['custom_width'] = _vw
            if 'custom_height' in inp and not isinstance(inp.get('custom_height'), list):
                inp['custom_height'] = _vh
            injected = True
            print(f"[Yusu] frames={total_frames} fps={fps} resolution={_vres_label} use_audio={use_custom_audio}")
            break
    if not injected:
        comfy_cleanup_input_files(uploaded_names)
        return {'success': False, 'error': 'Yusu 工作流中未找到 YusuLTXDirector 节点'}

    try:
        try:
            found, _ = comfy_run_and_wait(
                workflow, want_kinds=('gifs', 'images', 'audio'), max_wait=3600,
                on_prompt_id=(lambda pid: _sb_job_set(task_id, prompt_id=pid)) if task_id else None,
                should_cancel=(lambda: _sb_job_cancelled(task_id)) if task_id else None,
            )
        except JobCancelled:
            return {'success': False, 'cancelled': True, 'error': '已打断'}
        except Exception as e:
            return {'success': False, 'error': str(e)}
        item = None
        for key in ('gifs', 'images', 'audio'):
            if found.get(key):
                item = found[key][0]; break
        if not item:
            return {'success': False, 'error': 'Yusu 导演台未产出视频'}
        content = comfy_fetch_view(item.get('filename', ''), item.get('subfolder', ''), item.get('type', 'output'))
        if not content:
            return {'success': False, 'error': '无法取回视频文件'}
        vpath = comfy_output_abspath(item.get('filename', ''), item.get('subfolder', ''), item.get('type', 'output'))
        return {'success': True, 'video_base64': base64.b64encode(content).decode('utf-8'),
                'mime': 'video/mp4', 'frames': total_frames,
                'video_file': vpath, 'video_name': item.get('filename', '')}
    finally:
        comfy_cleanup_input_files(uploaded_names)


# ==================== HTTP Handler ====================

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args): pass

    def send_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(200); self.send_cors(); self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api/media/'):
            self.serve_media()
        elif self.path.startswith('/api/video_file'):
            self.serve_video_file()
        else:
            self.send_response(200); self.send_header('Content-Type', 'text/plain')
            self.send_cors(); self.end_headers(); self.wfile.write(b'OK')

    def serve_video_file(self):
        """按绝对路径流式返回本机磁盘上的视频文件（索引到 ComfyUI 生成目录，不复制）。
        支持 HTTP Range，便于 <video> 拖动播放与拖放到剪辑软件。
        仅允许 .mp4/.webm/.mov/.mkv/.gif 等媒体扩展名，防止任意文件读取。"""
        from urllib.parse import urlparse, parse_qs, unquote
        qs = parse_qs(urlparse(self.path).query)
        raw = (qs.get('path') or [''])[0]
        fpath = unquote(raw)
        # 拖出/下载文件名：带 dl 参数时附加 Content-Disposition: attachment，
        # 让 Chromium 的 DownloadURL 拖放（剪映等剪辑软件）能把它识别为可拖出的文件。
        dl_name = (qs.get('dl') or [''])[0]
        ext = os.path.splitext(fpath)[1].lower()
        allow = {'.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
                 '.mkv': 'video/x-matroska', '.gif': 'image/gif', '.avi': 'video/x-msvideo'}
        if ext not in allow or not fpath or not os.path.isfile(fpath):
            self.send_error(404, 'Not found'); return
        mime = allow[ext]
        try:
            size = os.path.getsize(fpath)
        except Exception:
            self.send_error(404, 'Not found'); return
        rng = self.headers.get('Range')
        start, end = 0, size - 1
        is_partial = False
        if rng and rng.startswith('bytes='):
            try:
                part = rng.split('=', 1)[1].split('-')
                if part[0]:
                    start = int(part[0])
                if len(part) > 1 and part[1]:
                    end = int(part[1])
                is_partial = True
            except Exception:
                start, end, is_partial = 0, size - 1, False
        end = min(end, size - 1)
        length = end - start + 1
        self.send_response(206 if is_partial else 200)
        self.send_header('Content-Type', mime)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(length))
        if is_partial:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        if dl_name:
            self.send_header('Content-Disposition', _content_disposition(dl_name))
        self.send_cors()
        self.end_headers()
        try:
            with open(fpath, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            pass

    def serve_media(self):
        from urllib.parse import urlparse, parse_qs, unquote
        parsed = urlparse(self.path)
        rel = parsed.path[len('/api/media/'):]
        # 拖出/下载文件名：带 dl 参数时附加 Content-Disposition: attachment，
        # 让 Chromium 的 DownloadURL 拖放（剪映等剪辑软件）能把它识别为可拖出的文件。
        dl_name = (parse_qs(parsed.query).get('dl') or [''])[0]
        # rel format: <project_id>/<type>/<filename>
        parts = unquote(rel).split('/')
        data = None
        mime = 'application/octet-stream'

        # Try SQLite BLOB first
        if len(parts) >= 3:
            try:
                conn = get_db()
                row = conn.execute(
                    "SELECT data, mime FROM media_blobs WHERE project_id=? AND media_type=? AND filename=?",
                    (parts[0], parts[1], parts[2])
                ).fetchone()
                conn.close()
                if row:
                    data = row[0]
                    mime = row[1]
            except:
                pass

        # Fallback: read from file system
        if data is None:
            fpath = os.path.join(MEDIA_DIR, unquote(rel))
            if not os.path.isfile(fpath):
                self.send_error(404, 'Not found'); return
            ext = os.path.splitext(fpath)[1].lower()
            mime_map = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                        '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webp': 'image/webp'}
            mime = mime_map.get(ext, 'application/octet-stream')
            with open(fpath, 'rb') as f:
                data = f.read()

        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'max-age=3600')
        if dl_name:
            self.send_header('Content-Disposition', _content_disposition(dl_name))
        self.send_cors()
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        routes = {
            '/api/settings/save': self.save_settings_handler,
            '/api/settings/load': self.load_settings_handler,
            '/api/projects/list': self.list_projects,
            '/api/projects/save': self.save_project_handler,
            '/api/projects/load': self.load_project_handler,
            '/api/projects/delete': self.delete_project_handler,
            '/api/media/save': self.save_media_handler,
            '/api/media/delete': self.delete_media_handler,
            # Legacy compatibility
            '/api/sync_data': self.sync_data_legacy,
            '/api/load_data': self.load_data_legacy,
            '/api/generate_image': self.generate_image,
            '/api/generate_image_async': self.generate_image_async,
            '/api/image_task': self.image_task_status,
            '/api/generate_voice': self.generate_voice,
            '/api/extract_characters': self.extract_characters,
            # ===== 分镜相关 =====
            '/api/storyboard/generate': self.storyboard_generate,      # 异步：CC 生成分镜 JSON
            '/api/storyboard/fourgrid': self.storyboard_fourgrid,      # 异步：gpt-image-2 编辑生成四宫格
            '/api/storyboard/tts_clone': self.storyboard_tts_clone,    # 异步：Qwen3 语音克隆
            '/api/storyboard/video': self.storyboard_video,            # 异步：导演台视频生成
            '/api/sb_task': self.sb_task_status,                       # 统一查询分镜异步任务
            '/api/sb_cancel': self.sb_task_cancel,                      # 打断分镜异步任务（真实中断 ComfyUI）
            '/api/import_video': self.import_video_handler,            # 视频历史：拖放/上传导入，落盘一次后索引绝对路径
            '/api/open_path': self.open_path_handler,                  # 视频历史：在系统文件管理器中定位/打开该文件
            '/api/llm/optimize_prompt': self.llm_optimize_prompt,      # 同步：调用文本大模型优化/改写分镜提示语
        }
        handler = routes.get(self.path)
        if handler: handler()
        else: self.send_error(404, 'Not Found')

    def read_body(self):
        cl = int(self.headers.get('Content-Length', 0))
        if cl == 0: return {}
        return json.loads(self.rfile.read(cl).decode('utf-8'))

    def send_json(self, d, code=200):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json'); self.send_cors(); self.end_headers()
        self.wfile.write(json.dumps(d, ensure_ascii=False).encode('utf-8'))

    # ---- Settings ----

    def save_settings_handler(self):
        try:
            data = self.read_body()
            save_settings(data)
            self.send_json({'success': True})
        except Exception as e:
            self.send_json({'success': False, 'error': str(e)}, 500)

    def load_settings_handler(self):
        try:
            self.send_json({'success': True, 'settings': load_settings()})
        except Exception as e:
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- Projects ----

    def list_projects(self):
        try:
            self.send_json({'success': True, 'projects': load_index()})
        except Exception as e:
            self.send_json({'success': False, 'error': str(e)}, 500)

    def save_project_handler(self):
        try:
            d = self.read_body()
            pid = d.get('id', '')
            if not pid:
                self.send_json({'success': False, 'error': '缺少项目ID'}, 500); return
            save_project(pid, d)
            self.send_json({'success': True})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    def load_project_handler(self):
        try:
            d = self.read_body()
            pid = d.get('id', '')
            if not pid:
                self.send_json({'success': False, 'error': '缺少项目ID'}, 500); return
            proj = load_project(pid)
            if proj:
                self.send_json({'success': True, 'project': proj})
            else:
                self.send_json({'success': False, 'error': '项目不存在'}, 404)
        except Exception as e:
            self.send_json({'success': False, 'error': str(e)}, 500)

    def delete_project_handler(self):
        try:
            d = self.read_body()
            pid = d.get('id', '')
            if not pid:
                self.send_json({'success': False, 'error': '缺少项目ID'}, 500); return
            delete_project_db(pid)
            self.send_json({'success': True})
        except Exception as e:
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- Media ----

    def save_media_handler(self):
        try:
            d = self.read_body()
            pid = d.get('project_id', '')
            media_type = d.get('type', 'images')
            base64_data = d.get('data', '')
            if not pid or not base64_data:
                self.send_json({'success': False, 'error': '缺少参数'}, 500); return
            rel_path = save_media_file(pid, media_type, base64_data)
            self.send_json({'success': True, 'path': rel_path})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    def import_video_handler(self):
        """视频历史「拖放/上传导入」：浏览器拿不到本地绝对路径，故把文件内容（base64）落盘到 IMPORT_DIR，
        返回该文件的绝对路径，前端以此路径索引（不再二次复制），与生成的视频共用 /api/video_file 播放/拖出。"""
        try:
            d = self.read_body()
            b64 = d.get('data', '') or ''
            name = (d.get('filename', '') or 'import.mp4').strip()
            if ',' in b64 and b64[:5].lower() == 'data:':
                b64 = b64.split(',', 1)[1]
            elif b64.startswith('data:'):
                b64 = b64.split(',', 1)[1] if ',' in b64 else ''
            if not b64:
                self.send_json({'success': False, 'error': '缺少视频数据'}, 400); return
            ext = os.path.splitext(name)[1].lower()
            allow = {'.mp4', '.webm', '.mov', '.mkv', '.avi', '.gif'}
            if ext not in allow:
                ext = '.mp4'
            os.makedirs(IMPORT_DIR, exist_ok=True)
            # 安全文件名 + 时间戳，避免覆盖
            safe = re.sub(r'[\\/:*?"<>|]', '_', os.path.splitext(name)[0])[:60] or 'import'
            fname = f"{safe}_{int(time.time()*1000)}{ext}"
            fpath = os.path.join(IMPORT_DIR, fname)
            with open(fpath, 'wb') as f:
                f.write(base64.b64decode(b64))
            self.send_json({'success': True, 'video_file': fpath, 'video_name': fname})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    def open_path_handler(self):
        """在系统文件管理器中定位/选中该文件（视频历史「打开路径」）。
        macOS: open -R；Windows: explorer /select；Linux: xdg-open 所在目录。仅 backend 与浏览器同机时有效。"""
        try:
            d = self.read_body()
            fpath = (d.get('path', '') or '').strip()
            if not fpath or not os.path.exists(fpath):
                self.send_json({'success': False, 'error': '文件不存在或路径为空'}, 404); return
            sysname = sys.platform
            if sysname == 'darwin':
                subprocess.Popen(['open', '-R', fpath])
            elif sysname.startswith('win'):
                # explorer /select 需要反斜杠路径
                subprocess.Popen(['explorer', '/select,', os.path.normpath(fpath)])
            else:
                # Linux：定位到所在目录
                subprocess.Popen(['xdg-open', os.path.dirname(fpath) or '.'])
            self.send_json({'success': True})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    def delete_media_handler(self):
        """Delete media BLOB from SQLite AND file from disk."""
        try:
            d = self.read_body()
            path = d.get('path', '')
            if not path:
                self.send_json({'success': False, 'error': '缺少路径'}, 500); return
            # path format: media/<pid>/<type>/<filename>
            parts = path.split('/')
            if len(parts) >= 4:
                pid, mtype, fn = parts[1], parts[2], parts[3]
                # Delete from SQLite
                conn = get_db()
                conn.execute("DELETE FROM media_blobs WHERE project_id=? AND media_type=? AND filename=?",
                            (pid, mtype, fn))
                conn.commit()
                conn.close()
            # Delete from filesystem
            fpath = os.path.join(BASE_DIR, path)
            if os.path.isfile(fpath):
                os.remove(fpath)
            self.send_json({'success': True})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- Legacy ----

    def sync_data_legacy(self):
        try:
            d = self.read_body()
            if 'settings' in d:
                save_settings(d['settings'])
            if 'projects' in d:
                for proj in d['projects']:
                    save_project(proj['id'], proj)
            self.send_json({'success': True})
        except Exception as e:
            self.send_json({'success': False, 'error': str(e)}, 500)

    def load_data_legacy(self):
        try:
            settings = load_settings()
            idx = load_index()
            projects = []
            for entry in idx:
                proj = load_project(entry['id'])
                if proj:
                    projects.append(proj)
            self.send_json({'success': True, 'data': {'projects': projects, 'settings': settings}})
        except Exception as e:
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- Image Generation ----

    def generate_image(self):
        """同步生成（保留向后兼容）。"""
        try:
            d = self.read_body()
            prompt = d.get('prompt', '')
            if not prompt:
                self.send_json({'success': False, 'error': '缺少提示词'}, 500); return
            images, error = _call_image_api(
                prompt, d.get('api_url', 'https://token.ithinkai.cn/v1'), d.get('api_key', ''),
                d.get('model', 'dall-e-3'), d.get('size', '1792x1024'), d.get('quality', 'auto'), d.get('n', 1))
            if images:
                self.send_json({'success': True, 'images': images, 'mime': 'image/png'})
            else:
                self.send_json({'success': False, 'error': error or '未获取到图像数据'}, 500)
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    def generate_image_async(self):
        """提交异步图像任务，立即返回 task_id；后台线程实际生成，结果可凭 task_id 取回。"""
        try:
            d = self.read_body()
            prompt = d.get('prompt', '')
            if not prompt:
                self.send_json({'success': False, 'error': '缺少提示词'}, 500); return
            _cleanup_image_jobs()
            task_id = d.get('task_id') or f"img_{int(time.time()*1000)}_{random.randint(1000,9999)}"
            params = {
                'prompt': prompt,
                'api_url': d.get('api_url', 'https://token.ithinkai.cn/v1'),
                'api_key': d.get('api_key', ''),
                'model': d.get('model', 'dall-e-3'),
                'size': d.get('size', '1792x1024'),
                'quality': d.get('quality', 'auto'),
                'n': d.get('n', 1),
            }
            with image_jobs_lock:
                image_jobs[task_id] = {'status': 'pending', 'images': None, 'error': None,
                                       'ts': time.time(), 'prompt': prompt}
            threading.Thread(target=_run_image_job, args=(task_id, params), daemon=True).start()
            self.send_json({'success': True, 'task_id': task_id, 'status': 'pending'})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    def image_task_status(self):
        """查询异步图像任务状态。done 时返回 images；取走后即清理，防止重复占用内存。"""
        try:
            d = self.read_body()
            task_id = d.get('task_id', '')
            if not task_id:
                self.send_json({'success': False, 'error': '缺少 task_id'}, 400); return
            with image_jobs_lock:
                job = image_jobs.get(task_id)
                if job is None:
                    # 任务不存在（可能已过期被清理，或服务重启）
                    self.send_json({'success': True, 'status': 'missing'}); return
                status = job['status']
                if status == 'done':
                    images = job['images']
                    image_jobs.pop(task_id, None)
                    self.send_json({'success': True, 'status': 'done', 'images': images, 'mime': 'image/png'}); return
                if status == 'error':
                    error = job['error']
                    image_jobs.pop(task_id, None)
                    self.send_json({'success': True, 'status': 'error', 'error': error}); return
                self.send_json({'success': True, 'status': status})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- Voice Generation ----

    def generate_voice(self):
        try:
            d = self.read_body()
            char_name = d.get('character_name', '')
            voice_desc = d.get('voice_desc', '')
            tts_text = d.get('text', f"我是{char_name}，这是我的音色，很高兴认识你")
            task_id = d.get('task_id', str(int(time.time()*1000)))
            # 语音设计工作流：'qwen3'(默认) | 'voxcpm'
            design_wf = d.get('voice_design_workflow') or 'qwen3'

            if not char_name:
                self.send_json({'success': False, 'error': '缺少人物名称'}, 500); return

            if tts_busy.locked():
                self.send_json({'success': False, 'error': '正在处理其他任务，请稍后重试'}, 503); return

            task = {'id': task_id, 'character_name': char_name, 'voice_desc': voice_desc, 'text': tts_text,
                    'voice_design_workflow': design_wf}
            tts_queue.put(task)

            for _ in range(120):
                time.sleep(2)
                if task_id in tts_results:
                    result = tts_results.pop(task_id)
                    self.send_json(result, 200 if result.get('success') else 500)
                    return

            self.send_json({'success': False, 'error': 'TTS超时'}, 500)
        except Exception as e:
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- Character Extraction ----

    def extract_characters(self):
        """提交『提取人物/道具/场景』异步任务（与分镜生成同一套：提交→task_id→轮询）。
        可关闭弹窗后台运行、可停止。"""
        try:
            d = self.read_body()
            params = {
                'project_id': d.get('project_id', 'default'),
                'script': d.get('script', ''),
                'prompt': d.get('prompt', ''),
            }
            if not params['script']:
                self.send_json({'success': False, 'error': '缺少剧本内容'}, 400); return
            task_id = _submit_sb_job('extract', _run_extract_job, params)
            self.send_json({'success': True, 'task_id': task_id, 'status': 'pending'})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- 分镜：CC 生成分镜 JSON（异步） ----

    def storyboard_generate(self):
        """提交分镜生成任务（CC）。前端传 script + 已有 characters/props/scenes + storyboardPrompt。"""
        try:
            d = self.read_body()
            params = {
                'project_id': d.get('project_id', 'default'),
                'script': d.get('script', ''),
                'prompt': d.get('prompt', ''),
                'characters': d.get('characters', []),
                'props': d.get('props', []),
                'scenes': d.get('scenes', []),
            }
            if not params['script']:
                self.send_json({'success': False, 'error': '缺少剧本内容'}, 400); return
            task_id = _submit_sb_job('sbgen', _run_storyboard_job, params)
            self.send_json({'success': True, 'task_id': task_id, 'status': 'pending'})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- 分镜：四宫格生成（gpt-image-2 编辑，异步） ----

    def storyboard_fourgrid(self):
        try:
            d = self.read_body()
            prompt = d.get('prompt', '')
            if not prompt:
                self.send_json({'success': False, 'error': '缺少四宫格提示词'}, 400); return
            params = {
                'prompt': prompt,
                'ref_images': d.get('ref_images', []),   # base64 列表（人物/道具/场景参考图）
                'api_url': d.get('api_url', 'https://token.ithinkai.cn/v1'),
                'api_key': d.get('api_key', ''),
                'model': d.get('model', 'gpt-image-2'),
                'size': d.get('size', 'auto'),
                'quality': d.get('quality', 'auto'),
            }
            task_id = _submit_sb_job('fourgrid', _run_fourgrid_job, params)
            self.send_json({'success': True, 'task_id': task_id, 'status': 'pending'})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- 文本大模型：优化 / 改写分镜提示语（同步） ----

    def llm_optimize_prompt(self):
        """用文本大模型优化或改写分镜提示语，模型只返回结果文本。
        入参：
          mode: 'optimize'(优化单条 local，默认) | 'expand'(改写成4格四宫格各自描述)
          prompt: 待优化/改写的原始提示语
          script: 剧本全文（作为背景参考，可空）
          system_prompt: 可选，覆盖默认系统提示词（设置页可配置；含 {script} 占位）
          api_url / api_key / model: LLM 配置（设置页可配置）
        返回：optimize → {success, text}；expand → {success, text, lines:[4]}"""
        try:
            d = self.read_body()
            mode = (d.get('mode') or 'optimize').strip()
            prompt = (d.get('prompt') or '').strip()
            if not prompt:
                self.send_json({'success': False, 'error': '缺少待优化的提示语'}, 400); return
            script = (d.get('script') or '').strip()
            api_url = d.get('api_url') or 'https://api.deepseek.com'
            api_key = d.get('api_key') or ''
            model = d.get('model') or 'deepseek-v4-flash'
            if not api_key:
                self.send_json({'success': False, 'error': '未配置文本大模型 API Key（请在设置页填写）'}, 400); return
            # 系统提示词：优先用用户在设置里配置的；否则用默认。{script} 注入剧本（截断防超长）。
            default_sys = DEFAULT_EXPAND_PROMPT if mode == 'expand' else DEFAULT_OPTIMIZE_PROMPT
            sys_tmpl = d.get('system_prompt') or default_sys
            script_for_prompt = script[:6000] if script else '（未提供剧本，仅依据下方提示语优化）'
            try:
                system_content = sys_tmpl.replace('{script}', script_for_prompt)
            except Exception:
                system_content = sys_tmpl + '\n\n【剧本背景参考】\n' + script_for_prompt
            messages = [
                {'role': 'system', 'content': system_content},
                {'role': 'user', 'content': prompt},
            ]
            text, err = _call_text_llm(messages, api_url, api_key, model)
            if err:
                self.send_json({'success': False, 'error': f'大模型调用失败: {err}'}, 502); return
            text = text.strip().strip('"').strip('“”').strip()
            resp = {'success': True, 'text': text}
            if mode == 'expand':
                # 取非空行，最多 4 行，去掉可能的「1. / - / 第1格：」前缀
                lines = []
                for ln in text.splitlines():
                    s = ln.strip()
                    if not s:
                        continue
                    s = re.sub(r'^\s*(第?\s*[1-4一二三四]\s*[格幕、.):：]\s*|[-*•]\s*|\d+[.)、]\s*)', '', s)
                    lines.append(s.strip())
                resp['lines'] = (lines + [''] * 4)[:4]
            self.send_json(resp)
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- 分镜：语音克隆（Qwen3，异步） ----

    def storyboard_tts_clone(self):
        try:
            d = self.read_body()
            params = {
                'ref_audio_b64': d.get('ref_audio_b64', ''),
                'ref_audio_mime': d.get('ref_audio_mime', 'audio/wav'),
                'text': d.get('text', ''),
                'ref_text': d.get('ref_text', ''),   # 语气/参考文本
                'workflow': (d.get('workflow') or 'vocpm'),   # 语音克隆工作流：vocpm(默认) | qwen3 | indextts
                'emotions': d.get('emotions') or {},   # IndexTTS-2 情感向量 {Happy/Angry/...: 0~1.4}
            }
            if not params['text']:
                self.send_json({'success': False, 'error': '缺少台词文本'}, 400); return
            task_id = _submit_sb_job('ttsclone',
                lambda tid, p: _sb_job_set(tid, **(lambda r: {'status': 'done', 'result': r} if r.get('success') else {'status': 'error', 'error': r.get('error')})(run_tts_clone_sync(p))),
                params)
            self.send_json({'success': True, 'task_id': task_id, 'status': 'pending'})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- 分镜：导演台视频生成（LTX2.3，异步） ----

    def storyboard_video(self):
        try:
            d = self.read_body()
            params = {
                'segments': d.get('segments', []),
                'imageSegments': d.get('imageSegments'),
                'audioSegments': d.get('audioSegments'),
                'total_frames': d.get('total_frames'),
                'global_prompt': d.get('global_prompt', ''),
                'epsilon': d.get('epsilon', 0.001),
                'guide_strength': d.get('guide_strength', '1.00'),
                'use_custom_audio': d.get('use_custom_audio', None),
                'fps': d.get('fps', 30),
                # 选择导演台工作流：'director'(默认，旧 LTXDirector) | 'singularity'(乱神版 V3) | 'yusu'(Yusu 导演台)
                'workflow': (d.get('workflow') or 'director'),
                # 生成视频分辨率（格式「宽 x 高 (比例)」），由各工作流 runner 注入对应节点
                'resolution': (d.get('resolution') or '1280 x 720 (16:9)'),
            }
            has_new = bool(params.get('imageSegments')) or bool(params.get('audioSegments'))
            if not params['segments'] and not has_new:
                self.send_json({'success': False, 'error': '缺少分镜段'}, 400); return
            def _director_worker(tid, p):
                _sb_job_set(tid, status='running')
                wf = p.get('workflow')
                if wf == 'singularity':
                    runner = run_director_singularity_sync
                elif wf == 'yusu':
                    runner = run_director_yusu_sync
                else:
                    runner = run_director_sync
                r = runner(p, task_id=tid)
                if r.get('success'):
                    _sb_job_set(tid, status='done', result=r)
                elif r.get('cancelled'):
                    _sb_job_set(tid, status='cancelled', error='已打断')
                else:
                    _sb_job_set(tid, status='error', error=r.get('error'))
            task_id = _submit_sb_job('director', _director_worker, params)
            self.send_json({'success': True, 'task_id': task_id, 'status': 'pending'})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- 分镜：统一异步任务查询 ----

    def sb_task_status(self):
        try:
            d = self.read_body()
            task_id = d.get('task_id', '')
            if not task_id:
                self.send_json({'success': False, 'error': '缺少 task_id'}, 400); return
            with sb_jobs_lock:
                job = sb_jobs.get(task_id)
                if job is None:
                    self.send_json({'success': True, 'status': 'missing'}); return
                status = job['status']
                if status == 'done':
                    result = job['result']
                    sb_jobs.pop(task_id, None)
                    self.send_json({'success': True, 'status': 'done', 'result': result}); return
                if status == 'error':
                    error = job['error']
                    sb_jobs.pop(task_id, None)
                    self.send_json({'success': True, 'status': 'error', 'error': error}); return
                if status == 'cancelled':
                    sb_jobs.pop(task_id, None)
                    self.send_json({'success': True, 'status': 'cancelled', 'error': job.get('error') or '已打断'}); return
                self.send_json({'success': True, 'status': status})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)

    # ---- 分镜：打断异步任务（真实中断 ComfyUI 执行） ----

    def sb_task_cancel(self):
        try:
            d = self.read_body()
            task_id = d.get('task_id', '')
            if not task_id:
                self.send_json({'success': False, 'error': '缺少 task_id'}, 400); return
            with sb_jobs_lock:
                job = sb_jobs.get(task_id)
                if job is None:
                    self.send_json({'success': True, 'status': 'missing'}); return
                job['cancelled'] = True
                job['ts'] = time.time()
                proc = job.get('proc')   # CC 分镜/提取任务的 Claude Code 进程
            # 1) 若是 Claude Code 任务：直接杀掉进程树，释放 claude_output.txt 句柄
            if proc is not None:
                _kill_proc_tree(proc)
                _sb_job_set(task_id, status='cancelled', error='已打断', proc=None)
            # 2) 若是 ComfyUI 视频任务：请求中断（worker 轮询也会再触发一次，双保险）
            comfy_interrupt()
            self.send_json({'success': True, 'status': 'cancelling'})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.send_json({'success': False, 'error': str(e)}, 500)


# ==================== Server ====================

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

def run_server(port=8765):
    init_db()
    migrate_if_needed()
    worker = threading.Thread(target=run_tts_worker, daemon=True)
    worker.start()
    server = ThreadedHTTPServer(('localhost', port), Handler)
    print(f'API: http://localhost:{port}  (SQLite: {DB_FILE})')
    server.serve_forever()

if __name__ == '__main__':
    run_server()
