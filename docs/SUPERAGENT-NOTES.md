# Super-agent 学习笔记（给 dsh-bili-faship v0.2 用）

> 写成时间：2026-11-07 · 作者：dsh-bili-faship 文档负责人
> 这份是**学习笔记**，不是产品文档：记录我们为什么在 v0.2 引入「工单」这套结构、
> 从官方原型里借了什么、刻意没借什么。插件自身的契约以 [`../DESIGN.md`](../DESIGN.md) §10 为准。
> 官方资料只读参考，本插件没有复制其代码。

## 1. 官方原型是什么

`deepseek-ai/dsh-superagent-prototype` 是 DeepSeek 官方放出的**研究原型**：
一个面向**单个代码仓库**的 *proactive coding agent*（主动型编程智能体），以 **DSH bundle** 的形式运行，
仓库以 **MIT** 许可公开。

它要回答的问题不是「怎么让模型写代码」，而是：

> 如果让一个 agent 长期待命、自己决定什么时候该做事、把结果交回给人，
> 那么**授权、执行、记录、以及「什么时候该打扰人」**这四件事应该长什么样？

作为研究原型，它的文档明确这是探索性工作（exploring super-agent design），接口与行为会变、
不承诺生产稳定性。**我们只借它的结构，不照搬它的规模与实现**：
它服务「一个团队的仓库 + GitHub/飞书两个 Source + 多个并发 worker」，
我们服务「一台机器 + 一个视频号 + 一个时钟 Source + 一条流水线」。

## 2. 它的一条主线（flow）

官方 domain 文档把工作流写成一句话：

```
Source 产生 Trigger → Trigger 属于 Thread → Eval 决定要不要开新工作
→ accept 时创建 Ticket（附 Mandate）→ Assignment 把 Ticket 交给 Executor
→ Executor Session 干活 → Report 回来 → Panel 只把「需要人」的部分摆出来
```

关键不是这个顺序，而是**每一段都有落盘的身份和记录**：
一个 Trigger 不能重复建两张工单（幂等）、一张工单知道自己是**凭什么**被允许做的（Mandate）、
一次执行失败是**可恢复的 Assignment**，而不是"会话没了就没了"。

## 3. 核心概念（Source → Trigger → Eval → Mandate → Ticket → …）

官方把 **Source / Thread / Eval / Mandate / Subscription** 定义为核心 domain，其余概念支撑它们。
下面按**工作流顺序**把整条链上会用到的概念都列一遍（任务要的五段在这张表里都能找到）：

| 概念 | 中文 | 一句话 | 关键规则（官方原型） |
|---|---|---|---|
| **Source** | 来源 | 事件流：一种 kind + 一份实例配置 | 记读取位置，重启不重放；自己的 bot 消息在进入 domain 前丢掉 |
| **Trigger** | 触发 | 一个不可变事件 | 幂等单元：同一个 Trigger 被接受两次也只建一张工单；审计单元 |
| **Thread** | 线程 | 按时间排的 Triggers | Eval 同一 Thread 串行；Thread 挂 Subscription，后续消息自动到达工单 |
| **Eval** | 评估 | 两层：**gate（准入）+ assessment（研判）** | gate 确定性（谁能发起、强度 explicit/inferred）；assessment 才是模型判断 |
| **Mandate** | 授权 | accept 到底批准了什么 | 不可变：policyVersion + scope + strength + 命中的规则；扩范围 = 新工单 |
| **Ticket** | 工单 | 一次被授权的工作单元 | 只有 Eval 能创建；open → ended；**自己定义状态**，不跟随 Session |
| **Assignment** | 派工 | Ticket ↔ 一个 Executor 实例的绑定 | pending → running → ended，可多次；只有最终报告能从 Executor 侧结束工单 |
| **Executor Session** | 执行器会话 | 一张工单一个会话 + 一个目录 | `worker-<ticket id>`，目录在 `<stateDir>/work/<short>`；同会话可重试/恢复 |
| **Report** | 报告 | Assignment 向 Ticket 报的结构化状态 | `progress / waiting / ready / blocked / failed / dropped`；**不靠自由文本推断「在等人」** |
| **Attention** | 待人工决定 | 工单上等一个人回答的问题 | Panel 第一屏；有具体动作（回复/重试/停止），不是一条含糊通知 |

还有两个辅助概念：**Policy**（版本化的准入规则集合，每个 Mandate 记下版本）和
**Panel**（只显示三类东西：需要人的、系统健康的、某件工作的历史）。

## 4. 哲学要点（000-philosophy）

官方文档的第一句就是判据：

> **Take as little human attention as possible, and give as much value as possible.**

由此推出的几条，我们几乎每一条都用得上：

1. **只花必要的注意力**：一条消息、一个通知、一个设置项、一段文档，都要证明自己值这个注意力，否则删掉。
2. **只在被要求、或有书面规则时行动**：没人要求的工作必须先有规则，并且**先以"只记录、不执行"的模式**起步。
3. **只在人必须行动、或结果可用时说话**：接单确认一次，干活期间安静，结果出来/需要决定/做不完才再说。
4. **一次只问一个具体问题**，而且用结构化形式问 —— 问题要到达人，而不是埋在长报告里。
5. **按影响停，不按努力停**：能到可审阅结果就做完；需要设计决策就带着明确问题停下。
6. **诚实状态**：草稿标未完成，失败就报失败，绝不为省一次追问而绕过限制。
7. **少概念、少设置**：默认值能覆盖的就不做设置；能用提示词说清的就不做机制。
8. **面板只显示需要人的**：健康状态不占空间；每个元素都回答"现在需要我吗 / 系统健康吗 / 这件事的历史是什么"。
9. **面板分类要可检查、互斥、覆盖全部情况**：标签说清"在等谁、等什么"，不是内部状态码。

## 5. 映射表：super-agent → dsh-bili-faship v0.2

| super-agent 原型 | 本插件 v0.2 | 差异 / 说明 |
|---|---|---|
| Source（GitHub / 飞书事件流） | **时钟**（生物钟 tick）+ **手动触发**（设置页/工具/HTTP） | 我们只有一个 Source，而且是"条件满足才产出 Trigger"的时钟；不接平台消息 |
| Trigger（不可变事件） | **一次调度尝试** | 不单独落 Trigger 表；准入记录 admission 就是审计单元 |
| Thread / Subscription | **不需要**（见 §7） | 一条视频的工作目录 + 工单本身就是上下文边界，没有"后续消息扇出" |
| Eval.gate（确定性准入） | **`admission`：确定性闸门** | 完全确定性：开关 / 到期 / 窗口 / 冷却 / 限额 / 索引状态 / 有任务在跑 / 有工单在做；**不花 token** |
| Eval.assessment（模型研判） | **不采纳** | 我们不需要"这条消息值不值得开工作"的语义判断：到期就该做，没到期就不该 |
| Policy / Mandate | **`policyVersion` + 工单 `mandate`** | 只用于审计（`source: schedule|manual`、basis、observeOnly、scope）；不实现撤权/重校验 |
| Ticket | **工单**（`tickets.json`） | 阶段由宿主从证据推导；per-ticket 会话；attention 挂在这里 |
| Assignment | **派工**（`dispatched` 事件 + `attempts`） | 一次派工 = 往会话投递一次工单叫醒词；失败有 attention 与退避重试 |
| Executor Session | **Worker 会话**（`bili-faship-<short>`，cwd=工单目录） | v0.2 默认 per-ticket；可配置切回 v0.1 的 persistent 单会话 |
| Report | **`faship_report`**（`progress/waiting/ready/blocked/failed/dropped`） | 结构化字段驱动阶段与 attention；不解析自由文本 |
| Attention | **「待你处理」面板**（`attention[]`） | 只放"不能无人继续"的：投递失败 / 阻塞 / 失败 / 等你审阅 |
| Panel | **设置页「视频工坊」顶部三块**：待你处理 / 工单 / 准入 | 健康时这几块不占空间；工单历史折叠 |
| Channel（回复回来源） | **`last-report.md` + 会话内汇报** | 我们不回写外部平台；"交给人的东西"是本地报告与面板 |
| Concurrency slots | **单机串行**（同时最多一个 `working/*`） | 一台机器一条流水线，不做 worker 池 |

## 6. 我们采纳了什么

v0.2 的净新增其实只有一个概念（**Ticket**）和它的配套记录：

1. **工单**：一次"做一条视频"有 id、有目录、有会话、有尝试次数、有时间线、有最终去向。
2. **准入记录**：每次 accept/reject 都写清原因（`due / not-due / out-of-window / cooldown / daily-limit / job-running / ticket-working / index-corrupt`…），可解释、可审计。
3. **阶段推导**：`stage` 由宿主按固定顺序从证据算出来（`person/*` 不能无人继续；`working/*` 在跑；`idle` 等下一次触发；`done/*` 结案），客户端只显示、不自己判断。
4. **per-ticket worker 会话**：每条片一个干净上下文，记忆走文件（日记 / 报告 / 工单历史），不让会话无限长大；可配置切回 `persistent`。
5. **结构化报告 `faship_report`**：status 只认六个值，宿主据此推阶段/生成 attention/结案，不猜自由文本。
6. **看门狗与恢复**：长任务超时/无输出 → 结束并标失败；宿主重启 → 遗留任务标 `interrupted`、开放工单挂 `host-restarted` attention；重试带恢复说明（先检查目录，别重复已完成的步骤）。
7. **自动重试**：只对"执行/投递类"失败（render-failed / job-failed / stalled / host-restarted / delivery-failed）退避重试，次数有限；`review-failed` 不自动重试（内容问题要人或 agent 手动改）。
8. **「待你处理」面板**：只放需要人的 attention，每项带「重试 / 我知道了」；空时整块隐藏。
9. **观察模式 `admission.observeOnly`**：仍然建工单、仍然叫醒，但只做选题 + storyboard 草稿 + 依赖检查 + 计划，**禁止 render / publish**，把"如果放开会怎么做"写进汇报。这是我们自己的"observe 起步"版本。

## 7. 刻意不采纳什么（DESIGN §10 · 12.10）

| 不采纳 | 理由 |
|---|---|
| Source / Thread / Subscription / Correlation / Channel | 我们只有一个时钟 Source、一个本地投递出口；没有"多来源、多线程、消息扇出"的需求。多一个概念就多一份要维护的状态 |
| Eval 的 LLM 研判（assessment） | 准入是**确定性**的：到期/窗口/冷却/限额，全部是数得出来的事实；花 token 让模型判断"今天该不该做"既慢又不可解释 |
| Policy 版本化 / Mandate 撤销 / 重校验 | 单用户本地工具，没有"规则变了要影响在途工单"的场景；`policyVersion` 只用于审计 |
| 多 Executor 并发 / worker 池 / 并发槽位 | 一台机器一条渲染流水线；同时最多一个 `working/*`。并发只会让风控和磁盘更难过 |
| 允许名单 / admission table / bot 名单 / accept mode（off/observe/auto） | 没有外部请求者，不需要"谁能发起工作"的矩阵；我们只有一个"总开关 + 观察模式" |
| 把 Panel 做成完整的管理后台（Source/Trigger/Eval 各一页） | 我们的信息量只够三块卡片；多了就是噪音 |

**一句话**：原型回答"一个 agent 团队怎么长期工作"；我们只抄它"工作要有身份、要能解释、要能恢复、只打扰必要的人"这四条纪律。

## 8. 术语对照（中英）

| 英文 | 中文 | 本插件里叫什么 |
|---|---|---|
| Source / Trigger | 来源 / 触发 | 时钟 tick / 手动触发 |
| Gate / Admission | 准入 | 准入（admission 记录） |
| Assessment | 研判 | —（不采纳） |
| Mandate | 授权 | 工单的 `mandate` 字段 |
| Ticket | 工单 | 工单（`tickets.json`） |
| Assignment / Dispatch | 派工 | 派工（`dispatched` 事件 / `attempts`） |
| Executor Session | 执行器会话 | Worker 会话（`bili-faship-<short>`） |
| Report | 报告 | `faship_report` / 工单 `report` |
| Attention | 待人工决定 | 「待你处理」 |
| Panel | 面板 | 设置页「视频工坊」 |
| Stage | 阶段 | 工单 `stage`（宿主推导） |
| Observe | 观察 | `admission.observeOnly` |

## 9. 引用与致谢

- 官方仓库：<https://github.com/deepseek-ai/dsh-superagent-prototype>（**MIT**，研究原型）
- 本笔记转述的官方文档（只读参考）：`000-philosophy.md`、`001-domain.md`、`002-authorization.md`、
  `003-execution.md`、`004-prompts.md`、`005-panel.md`，以及 `prompts/{admission,dispatch,work,worker}.md`。
- 引用内容仅作学习与设计说明；本插件**不包含**该仓库的任何代码或文案，实现见本仓库 `lib/tickets.mjs` 等文件。

## 10. 这份笔记的局限

- 只读了官方文档与提示词，没有通读实现代码；文档描述的是设计意图，不代表原型当前行为。
- 本插件按 [`../DESIGN.md`](../DESIGN.md) §10 的契约实现，**不承诺**与原型行为一致；
  将来原型若变化，本笔记只做"当时学到了什么"的历史记录，不跟进同步。
- 我们只借结构。规模、并发、多来源、外部平台写回都不在我们的问题域里。
