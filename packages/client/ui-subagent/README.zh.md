---
description: "dsh Web 客户端的 subagent 对话目录、续接路由 UI 与 '@' 引用 source。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent

[English](README.md) | 中文

## 概述

使用本包可浏览父会话下的每个 subagent 对话、打开任意后代，并查看其是否正在运行以及 token 用量和活跃轮次耗时。已完成的 one-shot 对话会作为只读执行记录打开。可继续对话在运行期间按提交顺序接收后续提示词，并独立提供 Stop。普通会话侧边栏会省略 subagent 对话，因此父会话页头目录与执行页面提供它们的导航入口。独立的 `@` source 会把运行中 child 的 label 插入用户消息，但不会把它解析成继续执行地址。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

会话页头把当前会话标题作为谱系面包屑；当会话的直接目录有子项或读取失败时，后代数量触发器渲染在页头操作区的最前方，不带任何面包屑分隔符。目录缺席、空目录加载中或成功加载为空时，均隐藏数量触发器。触发器打开该直接目录，报告总数与运行数，并且只在行展开时加载嵌套目录。选择任意深度，即可用该子会话的确切 `{parentSessionId, childSessionId, mode}` 地址打开其对话；也可以使用行尾箭头在右侧 Sidebar 打开同一地址，并在空间允许时优先使用独立分栏。

本包注册 `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>` 资源与 builtin Sidebar tab 类型。资源直接根据地址保留 child 的 `SessionReference`，不刷新 parent 目录，并在 tab 记录关闭时释放 reference。tab 通过 `sidebar.chat.conversation` 渲染共享 `conversation.content` Factory，把局部 View 固定为 Chat，并省略主 Conversation 的 Header 与宽度控制。

### 浏览目录

悬停触发器 150ms 后打开目录；指针离开触发器和目录后，经过 120ms 关闭。点击后代数量触发器会固定目录，直到点击外部，或在触发器或树内按 Escape 关闭。点击面包屑标题会导航至对应会话。

行显示 mode、活动状态与由日志支撑的可选 title；running 使用共享 ongoing loading，最近一个已结束轮次正常完成的 inactive child 使用共享 success 绿点，其他 inactive child 使用共享 idle 灰点。每行都为状态图标预留相同的 14px 列宽，并将较小的圆点居中，使 title 与 loading 状态对齐。紧凑的页头触发器会垂直居中活动图标与数量，并保留 4px 水平间距。尾随列在上行显示提供方的持久化 token 用量总计，在下行显示活跃轮次耗时。键盘导航：ArrowRight/ArrowLeft 展开和折叠分支；ArrowUp/ArrowDown、Home、End 与 Escape 用于导航或关闭树。没有 label 的 one-shot 行回退到其会话 id。只有一行自身的目录加载为空后，它才是已知叶子。

### 执行可见性

页头在 Chat 旁保持紧凑的执行状态，编辑器 dock 显示协调 agent 的阶段与上次使用的模型。查看执行会在现有右侧 Sidebar 打开 builtin `execution` 页面。活动页显示已加载历史中最近的轮次、工具步骤和已记录的结果状态；瞬时文本分片不更新活动投影。智能体页显示已知会话及其实时活动；每个 child 都以完整的直接父会话地址在 Sidebar 或主聊天中打开。关系图通过会话作用域的 `execution.graph` chain slot 委派已加载的 Chat 节点记录。Auto Recipes 按开始序号选择最近的已记录运行，复用紧凑的工作流图，以图标节点展示并在悬停或键盘聚焦时显示详情。没有已加载的工作流运行或没有 renderer 接管时，关系图提示在智能体页查看会话详情。

协调 agent 的完成或错误与仍在执行的 child 分别显示。child 只有在 `subagentTiming.lastTurnCompleted` 确认时才显示完成；其他 inactive child 结果仍显示当前未运行。模型来自 `modelSelection.lastUsed`，未知模型或推理强度会明确显示，绝不以用于下一次请求的选择代替。打开页面会为每个已知分支请求现有的投影基线一次；已就绪或正在进行的读取会被复用，推送的目录与状态投影持续更新这些分支。未知或正在加载的分支保持可见，读取失败时保留已有成员并提供重试，根目录已就绪且为空时显示没有子会话。轮次开始事件或工具调用不在历史窗口中时，已加载的轮次尾部仍保持可见，并明确标记缺失的记录。缺失的轮次活动保持未知，不重建未观察到的工作流。

### 续接对话

确切 parent 存活时，可继续 child 保留普通输入 chrome：child 运行期间输入和 Send 保持可用，因为每条后续消息都会进入 child 的 FIFO inbox，而独立的 Stop 经由 `subagents/interruptByParent` 路由。确切 parent 不可用且 child 未在运行的可继续 child 会选用说明恢复路径的只读编辑器；此类 child 仍在运行期间，selector 会让位给普通编辑器——输入区与 Send 被禁用，但独立的 Stop 保持可用。

### `@` 引用 source

`@` source 仍然刻意保持独立且惰性：候选是从 `ctx.sessions.list` 零 RPC 得到的运行中 child；pick 会插入字面文本 `@label `，codec 投影为 `@label`。它不参与命令裁决，也不会把 label 解析成继续执行地址。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[子代理运行时](../../subagent/subagent/README.zh.md)负责 continuation 与中断；[对话参考](../ui-conversation/README.zh.md)说明编辑器行为。

### 目录派生

页头谱系 renderer 通过标准 `useSessions` 钩子读取 `projectionsBySession`。renderer 从每个 Session 的共享值中选择 `subagentCatalog`，用于成员关系、展开控件与数量；活动状态优先使用统一 UI status，缺少时使用 Session 摘要；摘要提供标题与用量。展开行会按需加载初始目录。实时 projection 帧更新所有已加载层级，无需菜单订阅或重复成员查询。行在目录缺席、加载中或失败时保持可展开，并在目录就绪且为空后成为已知叶子。

打开目录下拉菜单不会请求其根目录。展开子节点目录或重试失败读取时调用 `refreshProjection`；共享投影值的变化会自动更新显示。

面包屑地址从 Provider 所绑定的 Session 地址和已加载的 parent 目录推导，也包括从未选中过的祖先。

### 耗时、完成状态与 token

每个可见目录层在包含运行中 child 时独立推进时钟；折叠该层或关闭菜单会释放时钟。token 用量总计为四个互不重叠的 `tokenUsage` 桶之和。`subagentTiming` 投影会累加已结束轮次的耗时，并记录最近一个已结束轮次是否以 `completed` 结束；新轮次开始时会清除该完成状态，直到自身的 `turn/end` 到达。耗时仅在运行中 child 存在未结束轮次时每秒递增一次，并在 child 变为 inactive 后冻结；被中断的未结束轮次以其同一切面的 `active.through` 为上界，绝不使用更新的会话元数据。

### 编辑器选举

one-shot child 始终选用只读编辑器。可继续 child 仅在其确切 parent 不可用且 child 未在运行时选用只读编辑器；否则普通编辑器的会话会经 `subagents/prompt` 路由提示词。本包绝不接收宿主上下文，也不调用面向模型的工具。

模式未知的目录项仍可见、可点击，没有标签时显示子会话 id。读取子历史并确认受支持模式前，输入区保持只读；读取失败在该子会话中报告。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖对话界面、宿主 seam 与设计笔记。

- [ui-conversation](../ui-conversation/README.zh.md)——承载页头操作与编辑器链的聊天界面。
- [ui-input-trigger](../ui-input-trigger/README.zh.md)——承载 `@` source 的建议机制。
- [subagent](../../subagent/subagent/README.zh.md)——可继续 child 背后的宿主能力 seam。
- [历史Web subagent 对话](../../../.agents/notes/archived/feature/2026-07-27-web-subagent-conversations.md)——目录与编辑器规范。
- [当前轮次中断](../../subagent/subagent/README.zh.md)——独立 Stop 的语义。

-----

<a id="model-experience"></a>
## 模型体验

### 用户提示词中的 subagent label 文本

#### 模型看到的内容

只有 `@` 引用 source 会影响模型输入：pick 的候选以字面文本 `@label` 进入普通用户消息，没有专用内容块或宿主侧解析。浏览目录、导航 child 与查看持久化 transcript（文本记录）都不会添加提示词 section；已接收的继续交互内容会经宿主 subagent 适配器成为普通 FIFO 用户消息。

#### Token 影响

有条件且仅追加：字面 `@label` 或用户后续消息只会向对应的新用户消息增加 token。目录与 transcript 操作增加零模型 token。

#### KV Cache 影响

仅追加。本包绝不改写更早的请求 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义目录能显示什么、`@` 引用意味着什么；它们是当前包约束。

- **非完成的 inactive 结果仍合并显示**：目录能区分最近一次正常完成与其他 inactive 状态，但不区分失败、取消、拒绝、token 耗尽或尚无已结束轮次的 child；UI 不公开 Activation 身份，停止能力仅限编辑器上针对运行中可继续 child 的当前轮次 Stop。
- **`@` 引用仍是显示标题文本**：重复或改名后的 label 会有歧义，因此它们刻意不获得继续执行语义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
