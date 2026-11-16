# 漫游形象与状态设计（评审草案）

对应 [#40](https://github.com/LiuMingyang-1/city-explorer-agent/issues/40)，关联 [epic #47](https://github.com/LiuMingyang-1/city-explorer-agent/issues/47)。

## 本次交付范围

圆脸沿用 BoopFace Lite，增加独立 SVG 渔夫帽、放大镜、小圆手。保留 upstream MIT 许可与来源，版本固定到 `assets/vendor/boopface/SOURCE.md` 的提交。
实现 7 种可持续保持的表情，独立预览页可切换，也展示 56px 小尺寸效果。
主页面、真实 SSE 消费、分身派发/地图飞行/回收尚未接入。
这些是可复用资产和控制器，不表示 #40 的全部验收已完成：分身组合与业务状态机还需对齐 #39 的最终事件协议。

## 表情与触发规则

| 控制器状态 | 视觉 | 建议进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `idle` | 正常眼睛、自然眨眼，可跟随指针 | 页面就绪、用户取消、终态提示结束 | 新请求开始 |
| `thinking` | 两眼小幅交替移动 | 请求已发送，规划/算路进行中 | 搜索、校验、需补充、成功或失败 |
| `searching` | 小圆手举放大镜到左眼前，镜内眼睛放大 1.2 倍，横向缓扫 | 真实检索开始；当前可用 `searching_events` 阶段表示粗粒度检索 | 检索结束/其他阶段、终态或取消 |
| `validating` | 眯眼检查 | `validating_schedule`；未来可接 critic 开始 | 检查结束或终态 |
| `happy` | 弯弯笑眼 | 收到有效 answer/plans 最终响应；记忆写入成功可短暂复用 | 新状态，或展示层结束短提示后回到当前业务状态 |
| `asking` | 头部轻歪、两眼略有高低 | clarification 响应；明确需要用户确认偏好 | 用户继续/拒绝、取消 |
| `confused` | 眼睛低垂 | 真实请求失败；最终确认无合适结果 | 用户重试、新请求、取消 |

普通等待不展示困惑；部分子任务失败但其他仍在执行，不把主脸直接切到失败。
用户取消恢复 idle，断连先清理分身再展示错误提示/困惑；二者区分于正常完成。
无搜索事件时不凭时间推断正在检索。当前仓库仅有 4 个粗粒度 progress stage，不能精确表现每个工具的开始/结束。

## 放大镜时序与遮挡

- 所有状态均保留轻微的左右律动：约 5.15 秒一个周期，横移幅度 1.8–3.2 SVG 单位、转角 1.1–2.4 度。开心多一点轻弹、询问轻歪头、检查慢扫视、困惑略低头。
- 切状态时用 280ms 平滑混合动作幅度，保持同一运动相位，快速切换不突然回正。帽子、脸、放大镜与小圆手共用动作层。
- 主预览与 56px 头像均启用动态；系统减少动态效果或显式 `motion="reduce"` 时保留静态表情。
- 7 种状态均自然眨眼：首次约 1–1.8 秒，之后间隔 2.2–4 秒，18% 概率短暂连眨一次；不连眨三次。保持表情时也允许眨眼，镜内引用同一只眼睛同步闭合。减少动态效果时仍遵循 upstream 静态处理。
- 进入 searching：240ms `1-(1-t)^3` 从左下抬起；持续搜索时，以约 5.3 秒周期小幅左右扫视。
- 放大镜与原眼睛使用相同扫视位置，镜内眼睛引用实时 SVG，保留眨眼；镜内只放大眼部，不放大整张脸。
- 退出 searching：240ms 原路放下。快速反转从当前可见进度继续；不等待旧动画完成才响应新状态。
- 帽子、脸、放大镜处于同一头部动作坐标系；帽檐遮挡同时覆盖头部、眼睛与眼皮，摘帽时解除。
- reduced-motion：道具立即显隐、无扫视；保留可辨认的静态表情。`motion="reduce"` 与系统偏好均生效。
- 动画时间只控制当前状态内的视觉，不推进真实业务阶段，不以计时器伪造任务完成。

## 后续 #41 的编排

业务状态与表情分开：

`idle → thinking → dispatching → exploring → merging → validating → done`

这是阶段集合，不要求固定顺序走完。无 delegate 时跳过派出与回收；搜索和校验可以多次发生；询问、取消、失败可在任何合法位置结束/暂停。

| 业务事件 | 表情/动作 |
| --- | --- |
| 前端请求开始 | 主脸 thinking |
| searching_events / 将来的工具开始事件 | 对应执行者 searching，举放大镜 |
| exploring_plans / routing | 主脸 thinking；不凭这些粗粒度事件创建虚构分身 |
| subagent_spawned | 按真实子任务实例创建分身，派出动作；主脸继续专注 |
| 子任务内真实搜索 | 该分身举放大镜；主脸不重复举镜 |
| subagent_done | 仅回收该实例，成功可开心一下；其他实例继续探索 |
| 全部探索任务终态 | 回收剩余视觉层；进入真实下一阶段，不推断必然已完成 |
| validating_schedule / critic 开始 | 主脸 validating |
| 最终 answer/plans | happy；最终 clarification → asking；错误 → confused |
| 用户取消/新会话/新一轮替代 | 放下放大镜，取消过渡，清理旧分身；idle/新一轮 thinking |
| memory_updates 中已落库变化 | 不抢占搜索等主状态；用通知条呈现，空闲时可复用开心 |

分身可独立实例化，支持 moss/sand/clay 三种帽色，方向由真实 title 标示；颜色按实例稳定分配，不预设为美食/文艺等固定角色。
分身数按实际并发探索任务创建，上限与 #38/#41 对齐；critic 不算新的探索方案。

### #39 协议对齐前不能假定的字段

Issue 中现有 `subagent_spawned`/`subagent_done`/`tool_call` 只描述草案，精确接入还需要确认：

- 稳定的轮次/run 与子任务 ID，以拒绝旧轮次迟到事件、正确回收同名任务。
- tool 的开始/结束/失败是否分开上报，含所属子任务与调用 ID；仅有带 result_count 的完成事件不足以表示整个搜索区间。
- 地图候选坐标来自哪个实际载荷；仅 stops_count/summary 不足以计算分身落位。
- 任务分类（探索/critic）与取消、超时、错误终态的表示方式。

这部分在 #39/#41 联调时落实；当前不发明线上已有字段。

## 前端消费接口

```js
import { createWanderMascot } from './wander-mascot.js';
const mascot = createWanderMascot(document.querySelector('boop-face'), {
  palette: 'moss', pointerFollow: true,
});
mascot.setState('searching');
mascot.setState('validating');
mascot.setState('happy');
mascot.setPalette('sand');
mascot.setHat(false);
```

控制器只负责视觉。请求生命周期、任务 ID 关联、状态优先级与终态提示时长由 #41 的编排层负责。
重复设置同状态无副作用；非法状态会抛错；移除 boop-face 时 upstream 生命周期停止帧循环。
控制器依赖固定版本的 SVG 结构和少量内部绘制接口，上游升级需要重新验证，不直接跟随 latest。

## 合入方式

1. 当前分支完成预览与可复用资产，提交独立 PR，关联 #40；未满足全部验收前不自动关闭 #40。
2. 评审确认 7 个状态、镜子位置和小尺寸辨识度后，先合入资产与设计文档。
3. #39 合入事件源，#41 基于最新 main 接入控制器、分身和地图；#43 单独接地图检索涟漪。
4. 联调覆盖无分身、1/2/3 个探索任务、乱序完成、重复/迟到事件、取消/断连/超时及减少动态效果。

预算：本地 vendored Lite 模块原始体积上限 350KB，自定义控制器不超过 20KB（未压缩）；无运行时 CDN、图片或新增框架。
