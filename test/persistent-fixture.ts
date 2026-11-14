import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import type { ExplorerConfig } from "../src/config.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { CONFIG, isDistillRequest, isSummaryRequest } from "./e2e-fixture.ts";

/** 持久化集成测试共享的小工具；测试自身断言留在各测试文件内。 */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(cond: () => boolean, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 5_000) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * 小窗配置：系统提示 ~2.4k（含 answer 契约、delegate_task 工具声明与派发节）、
 * search({date}) 结果 ~3.6k tokens；首轮 ~4.3k 不触发（<0.4×11500=4.6k），
 * 工具循环第二轮 ~5.0k 越过阈值触发压缩；窗口取 11_500 让二次压缩的
 * 摘要输入（system+摘要+工具尾部 ~9.5k）也装得下。
 */
export const TINY: ExplorerConfig = {
  ...CONFIG,
  baseUrl: "http://faux.invalid",
  contextWindow: 11_500,
  maxTokens: 300,
  compaction: {
    compactionThreshold: 0.4,
    compactionKeepRecentTokens: 150,
    compactionMaxTokens: 300,
  },
};

/** 手动压缩参数：keepRecent=100 → 保留末尾一小段尾部。 */
export const LOOSE = {
  compactionThreshold: 0.8,
  compactionKeepRecentTokens: 100,
  compactionMaxTokens: 300,
  maxTokens: 300,
};

export async function messageRecords(
  sessions: SessionRepository,
  sessionId: string,
  userId = "u-test",
) {
  return (await sessions.listRecords(userId, sessionId)).filter((r) => r.type === "message");
}

export async function compactionRecords(
  sessions: SessionRepository,
  sessionId: string,
  userId = "u-test",
) {
  return (await sessions.listRecords(userId, sessionId)).filter((r) => r.type === "compaction");
}

export const asText = (messages: AgentMessage[] | AgentMessage) => JSON.stringify(messages);

/**
 * 慢速 streamFn：主 faux 慢回复，摘要与蒸馏各走独立队列（供取消/竞争
 * 用例）。判别顺序：蒸馏也含 `<conversation>`，必须先查 isDistillRequest。
 */
export function slowStream(
  main: ReturnType<typeof createFauxCore>,
  summary: ReturnType<typeof createFauxCore> = createFauxCore({}),
  distill: ReturnType<typeof createFauxCore> = createFauxCore({}),
): StreamFn {
  return (model, context, options) =>
    (isDistillRequest(context) ? distill : isSummaryRequest(context) ? summary : main).streamSimple(
      model,
      context,
      options,
    );
}
