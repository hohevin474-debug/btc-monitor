# BTC Monitor - Cloudflare 免费部署

## 概述

BTC 实时监控系统，基于 Cloudflare Workers（免费计划），实现 24×7 云端运行。

### 架构
- **Worker**: 每分钟拉取 BTC 价格 → 技术分析 → 存储 KV → Bark 推送
- **KV**: 存储价格历史（最多300条）和信号状态
- **Cron Trigger**: 每分钟自动触发分析
- **Pages**: 托管前端面板（纯静态 HTML）

### 免费额度（完全够用）
| 资源 | 免费额度 | 本系统用量 |
|------|---------|-----------|
| Worker 请求 | 10万/天 | ~1500/天 |
| KV 读取 | 10万/天 | ~3000/天 |
| KV 写入 | 1000/天 | ~1500/天 |
| Cron 触发 | 免费 | 每分钟1次 |
| Pages 带宽 | 无限 | 极小 |

---

## 部署步骤

### 前置条件
1. 注册 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
2. 安装 Node.js（本地或使用本环境）

### 一键部署

```bash
# 1. 安装 Wrangler CLI
npm install -g wrangler

# 2. 登录 Cloudflare
wrangler login

# 3. 创建 KV 命名空间
wrangler kv:namespace create BTC_STATE
# 记下输出的 id，替换 wrangler.toml 中的 PLACEHOLDER

# 4. 部署 Worker
wrangler deploy

# 5. 部署前端面板到 Pages
# 先替换 public/index.html 中的 __WORKER_URL__ 为实际 Worker URL
wrangler pages deploy public --project-name btc-monitor
```

---

## 手动部署（如果你不会用命令行）

也可以直接在 Cloudflare 网页控制台操作：

### Step 1: 创建 Worker
1. 打开 https://dash.cloudflare.com/
2. 左侧菜单 → Workers & Pages → 创建应用程序 → 创建 Worker
3. 给 Worker 起名（如 `btc-monitor`）
4. 把 `src/worker.js` 的代码粘贴到编辑器
5. 点击「部署」

### Step 2: 创建 KV
1. Workers & Pages → KV → 创建命名空间
2. 名称：`BTC_STATE`
3. 回到 Worker → 设置 → 绑定 → 添加 KV 命名空间
4. 变量名：`BTC_STATE`，选择刚创建的命名空间

### Step 3: 设置 Cron 触发器
1. Worker → 设置 → 触发器 → 添加 Cron 触发器
2. Cron 表达式：`* * * * *`（每分钟）

### Step 4: 部署前端面板
1. Workers & Pages → 创建 → Pages → 上传资产
2. 上传 `public/` 目录
3. 项目名：`btc-monitor`
4. 部署后，把 `index.html` 中的 `__WORKER_URL__` 替换为你的 Worker URL（如 `https://btc-monitor.你的用户名.workers.dev`），重新上传

---

## 验证

部署完成后：
- Worker 健康检查：`https://你的worker.workers.dev/health`
- API 状态：`https://你的worker.workers.dev/api/state`
- 面板：Pages 提供的 `*.pages.dev` 域名

Bark 推送会在检测到强信号时自动发送到 iPhone。
