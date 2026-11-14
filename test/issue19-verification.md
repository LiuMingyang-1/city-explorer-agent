# Issue #19 验证记录（子任务 C：测试）

> `[bug][Agent] 行程后的信息问答误生成新行程，需支持普通回答类型`
> 契约：`{type:"answer",text:string}` —— 普通问答只追加聊天，不动行程指针 /
> 约束 / 方案历史 / 算路 / 地图；需持久化并可恢复。本文件由测试编码者维护，
> 只覆盖 `test/**`；`src/**`、`frontend/**` 为后端/前端子任务产出。

## 覆盖与结果

### C1 协议校验 — `test/answer-protocol.test.ts`（6 例，全过）

- 合法 `{"type":"answer","text":"…"}` 解析为 `{type:"answer", text}`；
- ```json 围栏、首尾空白、多余键与既有形态同口径兼容；
- `text` 缺失 / 空串 / 纯空白 / 非字符串 → `PlannerResponseError`；
- 非法 `type` 的错误信息须能把模型引回契约（枚举含 `"answer"`）；
- `clarify` / `itinerary` / `comparison` 三种旧形态解析行为不变。

### C2 多轮状态保护 — `test/answer-session.test.ts`（5 例）、`test/answer-persistent.test.ts`（2 例）、`test/web-e2e-answer.test.ts`（2 例），全过

- 生成方案 → 连续 answer（天气/预约/雨天影响）：`itinerary` 与 `constraints`
  不变，方案历史不新增，answer 轮不跑校验；
- 工具循环内 answer（模型先 `search_events` 再回答）不被纠正循环吞掉，
  一次解析即返回；
- 持久化：answer 轮 user/assistant 消息落库、不写 plan 标注、不挪
  `current_itinerary` 指针；重建会话后原方案/约束/消息历史恢复；
- `那帮我换成室内的` 修改轮在 answer 之后仍正常校验提交、推进指针；
- HTTP：`POST /api/chat` 返回 `kind:"answer"`（不带 plans/constraints），
  `GET /api/chat/history` 重开后行程卡与回答同时恢复，`mode`/`plans` 取自
  最后一个非 answer 轮；
- SSE：`/api/chat/stream` 中 answer 经 `meta → result` 回传，无
  `error`/`progress` 副作用。

### C3 前端 VM — `test/frontend-answer.test.ts`（8 例，全过）

基于 `test/frontend-fixture.ts` 的行为断言（非代码字符串）：

- answer 结果只追加 assistant 聊天：无新方案卡、`latestPlan`/`activePlanId`/
  选中方案不变、地图不重定位重绘、无算路；
- SSE 通道同样只追加聊天；
- 本地历史（localStorage）保存问答记录，重开后行程卡与回答同时恢复；
- answer 后"换成室内的"修改轮正常出新卡片；
- 演示 mock 通道：`?mock=answer` 走 `/data/mock-answer.json`，普通回答
  直接渲染、不出卡片。

### C5 Reviewer 定向补充（全过）

- **P2 截窗卡片**（`test/frontend-answer.test.ts`）：原卡片在 index 0、
  62 条消息、末条 answer 逐字复述方案 `summary`；`safeMessages` 60 条窗口
  把卡片截掉后 capture 记 `planIndex:null`；`open` 恢复出 60 条普通消息，
  末条 answer 原样保留、不在其位置重放卡片、`state.planMessageIndex` 为
  null、`latestPlan`/`activePlanId` 照常恢复。旧快照（无 `planIndex`
  字段）仍按文本回退恢复卡片——位置索引与文本回退边界符合实现契约。
- **comparison → 选 B → answer → 重开 → 修改**
  （`test/answer-persistent.test.ts`）：comparison 提交首 plan 后，携带
  `activePlan:"B"` 的 answer 只追加聊天不挪指针；重开后修改轮请求仍注入
  `用户当前选中的方案：B` 节（answer 轮未抢占 `latestProducedTurn` 的
  "最近方案轮"位置），answer 文本保留在上下文，修改正常提交并推进指针。
- **联网不可用/失败的回答路径**（`test/answer-session.test.ts`，mock 层）：
  - 未配置搜索 key：`web_search` 不挂载、提示词不含工具名；answer 返回、
    方案/约束不变，且不凭空发起联网调用（`toolCalls` 零新增）；
  - 已配置但调用失败：`web_search` 工具结果以 `isError` 回喂（不吞掉），
    后续模型响应解析为 answer 返回、方案/约束不变。
  - 说明：mock 层只断言"工具失败 → 仍可 answer 且不更新方案"的链路；
    回答措辞为 faux 脚本预设，"是否如实说明"属内容质量，mock 无法证明；
    真实联网成功路径的机器断言见 C4，内容质量仍未独立证实。

### C4 真实联网验证 — `test/issue19-real-verify.ts`（手动脚本，不进 `npm test`）

    node --env-file-if-exists=.env test/issue19-real-verify.ts

`.env` 实配：provider=deepseek（model=deepseek-flash）、web_search/amap
均已配置、`data/events.db` 为真实活动库。会话库放系统临时目录，运行结束
即清理，不写仓库数据，输出不含密钥。本机 2026-11-14 执行一次，PASS；
此后真实重跑未获审批，脚本只做离线断言增强、未再执行。

**证据分层（区分自动断言与人工观察）**：

- 机器断言项（`session.toolCalls` 事件记录 + `getCurrentItinerary`
  指针比较，非模型自述）：各轮 `turn.kind`、指针是否移动、工具名与
  isError 标志、调用次数。

| 轮 | 输入 | kind（断言） | 指针（断言） | 工具名/isError（断言） |
|---|---|---|---|---|
| 1 | 安排 2026-11-15 下午半日游（展览） | itinerary | 建立（≠null） | search_events×3, estimate_travel×1 |
| 2 | 明天天气怎么样 | answer | 未动（==轮1） | web_search×2，isError=false |
| 3 | 第二站需要预约吗 | answer | 未动 | web_search×1，isError=false |
| 4 | 下雨会影响这条路线吗 | answer | 未动 | 无工具调用 |
| 5 | 那帮我换成室内的 | itinerary | 推进（≠轮1） | estimate_travel×1 |

结果 `PASS: 0 处不符合契约`（仅指上述机器可断言项）。

- 人工观察项（当时脚本输出中的 answer 正文，供参考、未独立核验）：
  第 2 轮文本给出天气描述并列出来源说法；第 3 轮文本提及了与已生成
  行程第二站一致的场馆名；第 5 轮产出替换行程。**未核验项**：
  web_search 的调用参数与结果正文当时未留档，answer 内容是否取材于
  真实检索结果、天气/预约/来源描述是否属实、"第二站"解析是否语义
  正确，均无独立证据支撑——**真实内容质量仍未独立证实**，引用本
  记录时不得声称内容可信或来源已查实。脚本现已增强 args 摘要与
  isError/耗时留档（`[observe]` 行），但内容核验仍需人工。

## 命令与结果（最终态）

    node --test test/answer-protocol.test.ts test/answer-session.test.ts \
      test/answer-persistent.test.ts test/web-e2e-answer.test.ts \
      test/frontend-answer.test.ts        # 23/23 通过
    npm test                              # 827+ 全过（含既有套件无回归）
    npm run typecheck                     # 通过（tsc --noEmit 无错误）
    npm run check:frontend                # 通过

## 测试侧调整（本任务对既有 test/** 的修改）

- `test/e2e-fixture.ts`：新增 `answerEnvelope` 模型回复辅助。
- `test/persistent-fixture.ts`：TINY `contextWindow` 10_500 → 11_500。
  answer 契约使系统提示词增大 ~300 tokens，工具循环内第二次压缩的摘要
  输入（实测 9_479）超出旧窗口余量 3 tokens；新阈值 0.4×11_500=4_600
  下各测试触发点（4_299/4_987/5_218）仍正确跨越，`session-concurrency`
  全套回归通过。
- `test/agent-web-search.test.ts`：最终恢复 `!includes("web_search")`
  强断言并保留 `联网补盲` 门控段断言——实现终版把实时问答规则也移入
  `canWebSearch` 门控段，未挂载时提示词不再出现工具名，强断言成立。
- `test/session-runtime-regression-context.test.ts`、`test/session-concurrency.test.ts`：
  仅随 TINY 校准受益，未改断言。

## 实现依赖说明（供主控/reviewer 参考）

- 本批测试在实现落地前按 TDD 基线编写；实现未落地时曾以解析层
  `PlannerResponseError`、service 走 error 分支、前端"方案格式暂不支持"
  作复现证据。
- `src/compaction/{compact,summary}.ts` 一度残留 `console.error` 调试输出
  污染全部测试 stderr；当前工作树已清除，提交前请再确认未混入。
- 观察（非本 issue 回归）：`PersistentRuntime.latestTurn` 仅在实例初始化时
  从 runs 重建，同实例内 comparison 之后未重开的 `active_plan` 注入不生效
  ——即"选 B"上下文必须经重开/新实例才进入提示词。为既有行为边界，
  是否收窄由主控裁决。
- 其余既有套件（澄清、单方案、比选、修改、SSE、租约、压缩、历史）无回归。
