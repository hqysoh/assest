# 资产库管理系统 - 技术架构文档

## 1. 技术选型

### 1.1 前端框架
| 类型 | 选择 | 说明 |
|-----|-----|-----|
| 核心技术 | 纯 HTML/CSS/JS | 轻量级，无框架依赖，易于部署 |
| 构建工具 | 无 | 直接使用原生代码 |
| 本地存储 | localStorage | 存储项目数据和设置 |
| 文件系统 | File System API (模拟) | 浏览器环境下使用localStorage模拟文件存储 |

### 1.2 设计系统
- **主题系统**：CSS变量实现双主题切换
- **科幻风格**：几何元素、渐变、发光效果
- **响应式设计**：基础响应式布局

## 2. 文件结构设计

```
assest_html/
├── index.html          # 主入口
├── styles.css          # 全局样式
├── app.js              # 主应用逻辑
├── modules/
│   ├── home.js         # 主页模块
│   ├── project.js      # 项目详情模块
│   ├── script.js       # 剧本模块
│   ├── character.js    # 人物模块
│   └── settings.js     # 设置模块
└── utils/
    ├── storage.js      # 存储工具
    └── api.js          # API调用工具
```

## 3. 数据结构设计

### 3.1 项目数据结构
```javascript
{
  id: string,
  name: string,
  createdAt: timestamp,
  script: string,
  characters: [Character],
  prompt: string
}
```

### 3.2 人物数据结构
```javascript
{
  id: string,
  name: string,
  appearance: string,
  voice: string,
  currentImage: string,
  images: [Image]
}
```

### 3.3 全局设置结构
```javascript
{
  llmApiKey: string,
  llmApiUrl: string,
  imageApiKey: string,
  imageApiUrl: string,
  globalPrompt: string,
  theme: 'light' | 'dark'
}
```

## 4. 核心模块设计

### 4.1 状态管理
- 使用单例模式管理应用状态
- 状态变更触发UI更新
- localStorage持久化

### 4.2 路由系统
- URL hash路由
- 支持页面切换：home, project, settings
- 导航节点状态管理

### 4.3 存储模块
- 封装localStorage操作
- 支持项目CRUD
- 模拟文件系统

### 4.4 API模块
- 语言模型API调用
- 图像模型API调用
- 错误处理和重试

## 5. 关键实现路径

### 5.1 页面初始化流程
```
加载页面 → 读取本地存储 → 初始化状态 → 渲染主页
```

### 5.2 项目创建流程
```
输入项目名 → 创建数据 → 模拟文件夹创建 → 跳转到项目页
```

### 5.3 剧本保存流程
```
编辑内容 → 点击保存 → 存储内容 → 提供下载
```

### 5.4 人物图像生成流程
```
输入描述 → 调用API → 展示图像 → 保存到历史
```

## 6. 安全与性能

### 6.1 安全
- API密钥本地存储，不上传
- 输入验证和清理
- XSS防护

### 6.2 性能
- 按需渲染
- 图像懒加载
- 动画优化
