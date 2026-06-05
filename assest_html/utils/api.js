// 统一的后端 API 基址与请求封装。
// 历史遗留的 extractCharacters/generateCharacterImage 等方法已废弃（实际逻辑由各模块直接请求后端），此处仅保留统一基址工具，避免端口硬编码散落各处。
const API = {
    // 与 Storage.API 保持一致的后端基址
    get base() {
        return (typeof Storage !== 'undefined' && Storage.API) ? Storage.API : 'http://localhost:8765';
    },

    // 拼接后端接口完整地址
    url(path) {
        const p = path.startsWith('/') ? path : '/' + path;
        return this.base + p;
    },

    // 统一的 POST JSON 请求
    async post(path, body) {
        const r = await fetch(this.url(path), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        return r.json();
    }
};
