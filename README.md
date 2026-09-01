# Claude Model Patcher (SillyTavern Server Plugin)

让 SillyTavern 正确支持**新发布 / 自定义的 Claude 模型**（默认内置 `claude-opus-4-8`），
确保它们使用**正确的思考模式（自适应 adaptive / 扩展 extended / 关闭 none）**。

## 这个插件解决什么问题？

SillyTavern 是用**写死的正则表达式**（在 `src/endpoints/backends/chat-completions.js`）
根据模型名来决定一个 Claude 模型怎么处理“思考”：

- `useThinking` —— 是否支持思考
- `isAdaptiveModel` —— 是否用**自适应思考**（4.7+ 的新方式）
- `noSamplingModel` —— 是否禁用 temperature/top_p/top_k
- `noPrefillModel` —— 是否禁用 assistant 预填充
- `useVerbosity` / `useWebSearch` / `isLimitedSampling` 等

当 Anthropic 发布像 `claude-opus-4-8` 这种新模型、而 ST 还没更新时，
它会落进**错误的分支**（默认按旧的 extended/budget 思考处理），而新模型只支持自适应思考，
结果就是**思考开不起来 / API 报错**。

像 “Custom Models” 那类纯前端扩展只能往下拉框里**加个模型名字**，
**无法改后端逻辑**，所以加了 `opus-4-8` 之后思考依然是坏的。

本插件是一个 **Server Plugin（运行在 ST 后端）**，在 ST 启动时**自动给上述正则打补丁**，
把你配置的模型注入到对应能力里。默认把 `claude-opus-4-8` 当成和 `claude-opus-4-7` 一样
（自适应思考 + 无采样 + 无预填充 + verbosity + 1M 上下文）。

特性：
- **幂等**：已经打过补丁不会重复修改。
- **自动备份**：第一次修改前生成 `*.cmp-bak` 备份。
- **配置驱动**：以后出 `opus-4-9` 只要改 `config.json`，不用改代码。
- **手机端友好**：手机上独立安装的 ST（如 Termux）同样可用。

---

## 安装

> ⚠️ Server Plugin 需要在 ST 配置里手动开启，且只能从可信来源安装。

### 1. 放置插件

把整个 `claude-model-patcher` 文件夹放到 SillyTavern 的 `plugins/` 目录下：

```
SillyTavern/
└─ plugins/
   └─ claude-model-patcher/
      ├─ index.js
      ├─ package.json
      ├─ config.default.json
      └─ README.md
```

**手机 / 命令行从 GitHub 安装：**

```bash
cd /path/to/SillyTavern/plugins
git clone https://github.com/<你的用户名>/claude-model-patcher.git
```

（用 git 安装的话，ST 还能在 `enableServerPluginsAutoUpdate: true` 时自动更新。）

### 2. 开启 Server Plugins

编辑 SillyTavern 根目录的 `config.yaml`：

```yaml
enableServerPlugins: true        # 必须改成 true
enableServerPluginsAutoUpdate: true
```

### 3. 重启 SillyTavern

启动后控制台应出现：

```
[claude-model-patcher] Backend patched: claude-opus-4-8 -> useThinking, ... 
[claude-model-patcher]   Patch applied. RESTART SillyTavern once for it to take effect.
```

> 第一次打补丁后，**再重启一次** SillyTavern，补丁才真正生效
> （因为 `chat-completions.js` 在第一次启动时已被载入内存）。
> 之后每次启动它都会检测，已是最新就跳过。

### 4. 在前端选用模型

进入 Chat Completion → 选择 **Claude** 来源。
模型下拉框里如果没有 `claude-opus-4-8`，用 “Custom Models” 扩展添加这个名字即可，
或在 API 反代里直接传该模型名。思考模式现在会按自适应方式正确开启。

---

## 前端设置面板（推荐）

本项目附带一个**前端 UI 扩展** `SillyTavern-ClaudeModelPatcher`，让你在 ST 界面里
直接增删模型、选思考模式，不用手动编辑 `config.json`。

### 安装前端面板

把 `SillyTavern-ClaudeModelPatcher` 文件夹放到：

```
SillyTavern/data/<你的用户>/extensions/SillyTavern-ClaudeModelPatcher/
├─ manifest.json
├─ index.js
└─ style.css
```

或在 ST 的「扩展 → 安装扩展」里填 GitHub 仓库地址安装。

### 使用

1. 确保 **server plugin**（`claude-model-patcher`）已装好且 `enableServerPlugins: true`。
2. 打开 ST → 扩展面板（拼图图标）→ 找到 **Claude Model Patcher** 抽屉。
3. 顶部状态行会显示是否连上后端插件：
   - 绿色「已连接后端插件 ✓」= 正常。
   - 红色 = 后端 server plugin 没装 / 没开启。
4. 「添加模型」填模型名（如 `claude-opus-4-8`），选**思考模式**，勾选能力开关。
5. 点「**保存并打补丁**」。保存成功后**重启 SillyTavern** 生效。

> 前端面板只是 `config.json` 的可视化编辑器，真正打补丁的是 server plugin。
> 两者通过 `/api/plugins/claude-model-patcher/config` 通信。

---

## 配置 `config.json`（手动方式，可选）

首次运行会从 `config.default.json` 自动生成 `config.json`。也可手动编辑它来增删模型：

```json
{
    "enabled": true,
    "patchFrontend": true,
    "backendFile": "",
    "frontendFile": "",
    "models": [
        {
            "id": "claude-opus-4-8",
            "thinking": "adaptive",
            "context1m": true,
            "noSampling": true,
            "noPrefill": true,
            "verbosity": true,
            "webSearch": true
        }
    ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `enabled` | `false` 时完全不打补丁。 |
| `patchFrontend` | 是否同时给前端 `openai.js` 打补丁（仅用于 1M 上下文上限）。 |
| `backendFile` / `frontendFile` | 自动定位失败时，手动填**绝对路径**。一般留空即可。 |
| `models[]` | 要添加的模型列表，见下。 |

### 单个 model 的字段

| 字段 | 取值 | 含义 |
|------|------|------|
| `id` | 例如 `"claude-opus-4-8"` | 模型名（必须以 `claude-` 开头）。 |
| `thinking` | `"adaptive"` / `"extended"` / `"none"` | **思考模式**。`adaptive` = 4.7/4.8 的自适应思考；`extended` = 旧式预算思考；`none` = 不开启思考。 |
| `noSampling` | `true`/`false` | 禁用 temperature/top_p/top_k（4.7/4.8 需要）。 |
| `noPrefill` | `true`/`false` | 禁用 assistant 预填充。 |
| `verbosity` | `true`/`false` | 支持 verbosity / effort。 |
| `webSearch` | `true`/`false` | 支持内置 web search 工具。 |
| `context1m` | `true`/`false` | 前端允许把最大上下文拉到 1M。 |
| `limitedSampling` | `true`/`false` | 受限采样（top_p<1 时去掉 temperature 等）。一般不和 `noSampling` 同用。 |

> **思考模式怎么选？**
> - 新的 Opus 4.7 / 4.8 → `"adaptive"`（并建议 `noSampling: true, noPrefill: true`）。
> - Claude 3.7 / 早期 4.x 风格的预算思考 → `"extended"`。
> - 不想要思考 → `"none"`。

---

## 提示词缓存管理（v1.1 新增）

插件可以顺便接管 ST 的 **Claude 提示词缓存**设置（写入 `config.yaml` 的 `claude:` 段），
在前端面板里就能改，不用手动编辑 config.yaml：

```json
"caching": {
    "manage": true,
    "enableSystemPromptCache": true,
    "cachingAtDepth": 12,
    "depthMode": "switches",
    "extendedTTL": true,
    "patchCustomSource": false,
    "debug": false
}
```

| 字段 | 说明 |
|------|------|
| `manage` | `true` 才会写 config.yaml；`false` 完全不碰。 |
| `enableSystemPromptCache` | 缓存系统提示词+角色卡+工具列表（相当于"角色定义后"打点）。 |
| `cachingAtDepth` | 消息区打点深度。**填"发原文的楼层数 + 2"**：比如摘要方案只放行 10 层内原文就填 `12`；换成 20 层就填 `22`。`-1` = 关闭深度打点。聊天不足该深度时自动跳过，不影响系统提示词缓存。 |
| `depthMode`（v1.3 新增） | 打点位置的**计数方式**，类似世界书选注入位置：<br>`"switches"` = ST 原生，从底往上数 **user/assistant 角色轮换次数**。适合每层都发原文的常规聊天。**缺陷**：连续同角色消息（如"N 层外只发摘要"方案里的纯 assistant 摘要区）会被 Claude 转换器合并成一条消息、整个区只算 1 层深度，配置的深度可能永远数不到 → 聊天区断点根本打不上。<br>`"blocks"` = 按**楼层/文本块**计数：每条原始楼层即使被合并也各算 1 块，从底往上数第 N 块打点，断点可以落进合并后的摘要区内部。**摘要流强烈推荐**。 |
| `debug` | `true` 时在 ST 控制台打印每个断点实际落点（第几条消息 / 哪个文本块 / 内容预览），方便核对深度。 |
| `extendedTTL` | `true` = 缓存保 1 小时（写入贵一点，读 1 折）；`false` = 5 分钟。回合间隔常超 5 分钟建议开。 |
| `patchCustomSource`（v1.2 新增） | `true` 时给 ST 的**自定义(OpenAI兼容)源**也打上同样的缓存断点补丁（改的是 ST 源码而非 config.yaml，不受 `manage` 影响）。原版 ST 只在 Claude 和 OpenRouter 源加缓存标记，走自定义源的中转（如 **Vercel AI Gateway**）享受不到缓存；开启后只要模型名带 `claude`（如 `anthropic/claude-fable-5`），就自动按上面的开关和打点深度加 `cache_control` 标记。前提：中转必须原样透传 `cache_control`（Vercel AI Gateway 已实测支持，含 1h TTL）。 |

修改后同样**需要重启 SillyTavern** 生效（ST 启动时才读 config.yaml）。
首次修改前会备份 `config.yaml.cmp-bak`。

---

## 状态查询 / 手动重跑

插件注册了一个 API 端点：

- `GET  /api/plugins/claude-model-patcher/` —— 查看插件状态与上次补丁结果。
- `POST /api/plugins/claude-model-patcher/patch` —— 改完 `config.json` 后手动重跑补丁（仍需重启 ST 生效）。

---

## 卸载 / 还原

- 还原被修改的文件：把 `chat-completions.js.cmp-bak` / `openai.js.cmp-bak`
  覆盖回对应的 `chat-completions.js` / `openai.js`（去掉 `.cmp-bak` 后缀）。
- 或者直接 **更新/重装 SillyTavern**，源码会被官方版本覆盖。
- 然后删除 `plugins/claude-model-patcher/` 文件夹即可。

---

## 注意事项

- 本插件会**修改 ST 源码文件**（这是让思考逻辑生效的唯一可靠方式，前端扩展做不到）。
- **更新 SillyTavern 后**，源码会被覆盖、补丁丢失。重启 ST 时本插件会**自动重新打补丁**，
  无需手动操作（只要 `enableServerPlugins` 仍为 `true`）。
- 如果某个 ST 版本改了内部变量名 / 正则结构，插件会在日志里 `WARN: var ... not found`，
  此时只需更新本插件或反馈 issue。
