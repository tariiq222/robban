# Agent Note: 输入准入前的请求准备恢复

Status: implemented

[English](2026-10-04-request-preparation-recovery.md) | 中文

## Problem

路由插件可以在 `agent/request` 中选择提供方，但适配器绑定随后仍可能在 `prepareCall()` 中失败。流尚不存在，因此流恢复无法观察这种失败。重试整个步骤会重复输入准入或已完成工具，而在路由监听器内解析适配器也不会绑定后续调用。

## Decision

对于未取消的准备 `LlmError`，代理循环等待 `agent/request-prepare-error`。按代理作用域分发的 waterfall 携带现有结构化失败信息，并返回 `RequestErrorAction`。重试在同一步骤中重新执行路由与适配器绑定，保留已接纳的组装结果和消息。路由策略负责有限的尝试次数；循环在恢复前后检查取消状态。

监听器不委托而返回 `undefined` 会终止失败。调用 `next()` 则保留原生处理：未注册的路由仍可进入流中间件。这一区别防止已耗尽的托管 `NO_ADAPTER` 路由悄然进入兼容流处理。监听器异常仍为终态，取消和非 LLM 准备错误都不会进入恢复。

[流恢复决策](2026-06-21-bounded-llm-request-recovery.zh.md) 继续负责流开始后的失败。[外部事件决策](2026-08-30-retain-ignorable-external-session-events.zh.md) 继续负责可移植的信息回执；`Session.append()` 保留其现有 `ignorable: true` envelope 字段，不改变 Session 格式。这两个决策均未被取代。

## Alternatives considered

**复用 `agent/request-error`。** 该事件描述已准入的模型请求及其已结算的流尝试。准备阶段没有尝试流，也没有服务适配器的重试策略。

**在 `agent/request` 内绑定适配器。** 配置监听器无法绑定后续循环调用所使用的适配器。第二次准备仍可能失败。

**重试步骤或在每次 `NO_ADAPTER` 后继续。** 重复步骤可能重放已完成工具；无条件继续可能绕过托管路由已耗尽的策略。

## Consequences

恢复策略可以改变路由，而不准入失败请求的输入，也不重放工具。策略必须在有限路由预算耗尽时停止请求重试。未知的信息事件仅在生产者显式标记为 ignorable 时可移植；该标志不会绕过已知事件类型的校验。

聚焦回归覆盖路由、作用域、取消、有限尝试、原生兼容、终态失败和不可变追加元数据。共享 SDK 调度器恢复场景通过 TypeScript 和 Python 验证准备回执，不重复用户准入或已完成的工具结果。
