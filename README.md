# 歌曲时长计算器

本地音乐歌单管理工具，支持**网易云音乐**和 **QQ 音乐**在线歌单导入及单首歌曲搜索，可管理 KTV 歌单并记录演唱次数。

## 功能

| 模块 | 功能 |
|------|------|
| 歌曲搜索 | 按歌名/歌手/专辑组合搜索，网易云 + QQ 双平台，滚动自动翻页 |
| 歌单管理 | 创建/切换/删除歌单，拖拽排序，1-5★ 想唱等级 |
| 歌单导入 | 批量搜索、CSV 导入、网易云/QQ 在线歌单链接导入 |
| 导出 | 按歌单/等级/KTV 筛选导出纯文本或 CSV |
| KTV | 百度地图 POI 搜索 + 手动添加，标记歌曲可用/不可用 |
| 已唱记录 | 左键 +1 / 右键 -1，记录每次演唱时间，支持回退 |

## 截图

启动后浏览器打开 `http://localhost:3456`：

- **左栏**：搜索 / 歌单导入 / 导出
- **右栏**：歌单歌曲列表（拖拽排序、星级、KTV 按钮）
- **顶栏**：歌单切换、KTV 选择、导出、重置

## 技术栈

- **后端**：Node.js + Express
- **前端**：原生 HTML/CSS/JS（零框架）
- **存储**：本地 JSON 文件
- **API**：网易云音乐、QQ 音乐、百度地图 POI 搜索

## 快速开始

### 1. 环境要求

- [Node.js](https://nodejs.org/) >= 18
- 如需 KTV 搜索功能，需注册[百度地图开放平台](https://lbsyun.baidu.com/)获取 AK（免费配额每日 5000 次）

### 2. 安装

```bash
git clone https://github.com/yourname/song-duration.git
cd song-duration
npm install
```

### 3. 配置

复制配置模板并填入百度地图 AK（仅 KTV 搜索功能需要）：

```bash
cp config.example.json config.json
```

编辑 `config.json`：

```json
{
  "baiduAk": "你的百度地图AK"
}
```

如果不需要 KTV 搜索功能，保持默认值即可，不影响其他功能。

### 4. 启动

```bash
node server.js
```

浏览器打开 `http://localhost:3456`。

## 数据存储

所有数据保存在 `data/store.json`，结构如下：

```json
{
  "playlists": [{ "id": "...", "name": "歌单名", "songs": [...] }],
  "ktvs": [{ "id": "...", "name": "KTV名称", "availability": {}, "songHistory": {} }],
  "unsorted": { "songs": [] }
}
```

## License

MIT
