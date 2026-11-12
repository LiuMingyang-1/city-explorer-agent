/**
 * SSE（Server-Sent Events）写出助手：POST /api/chat/stream 的响应侧。
 *
 * - `event: x` + `data: <单行 JSON>` 帧与 `: ping` 注释帧经内部队列按序写出；
 *   res.write 返回 false 时等 drain 再写下一帧（背压不丢帧、不重叠写）。
 * - 心跳：默认每 15s 一行 `: ping`（心跳计时 unref，不拖住进程/测试收尾）；
 *   heartbeatMs 传 0 关闭。
 * - 断连：底层 close/error 立即标 closed、停心跳，残留队列帧静默丢弃——
 *   客户端已走，再写没有意义也不许抛错。
 * - end() 幂等：排空已入队帧后 res.end()；之后 send/comment 一律忽略。
 */

import type { ServerResponse } from "node:http";

/** progress 事件的线上契约（snake_case，与 planner 层 PlannerProgress 同形）。 */
export interface ChatProgress {
  stage: "searching_events" | "exploring_plans" | "routing" | "validating_schedule";
  message: string;
  plan_ids: string[];
}

/** error 事件的线上契约。 */
export interface ChatStreamError {
  error: { code: string; message: string; retryable: boolean };
}

export const SSE_HEARTBEAT_MS = 15_000;

export interface SseWriter {
  /** 入队一条 event/data 帧；data 一律 JSON.stringify（结果天然单行）。 */
  send(event: string, data: unknown): void;
  /** 入队一条 `: text` 注释帧。 */
  comment(text: string): void;
  /** 排空队列后 res.end()；幂等，调用后 send/comment 被忽略。 */
  end(): void;
  /** 底层 socket 已断/已收尾。 */
  readonly closed: boolean;
}

export function createSseWriter(
  res: ServerResponse,
  options: { heartbeatMs?: number } = {},
): SseWriter {
  let closed = false;
  let ending = false;
  // 帧写出串成 Promise 链：上一帧 drain 完才写下一帧。
  let chain: Promise<void> = Promise.resolve();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };
  const markClosed = () => {
    closed = true;
    stopHeartbeat();
  };
  res.on("close", markClosed);
  res.on("error", markClosed);

  /** write 返回 false 时等 drain 或 close（断连时不再傻等 drain）。 */
  const waitDrain = (): Promise<void> =>
    new Promise((resolve) => {
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
    });

  const writeChunk = async (chunk: string): Promise<void> => {
    if (closed || res.destroyed || res.writableEnded) return;
    try {
      if (!res.write(chunk)) await waitDrain();
    } catch {
      markClosed();
    }
  };

  const enqueue = (chunk: string): void => {
    if (closed || ending) return;
    chain = chain.then(() => writeChunk(chunk));
  };

  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => enqueue(": ping\n\n"), heartbeatMs);
    heartbeat.unref();
  }

  return {
    send(event, data) {
      // 先入队前先序列化：畸形数据在 send 调用点抛错（走 error 帧），
      // 不会污染队列里的既有帧。
      enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      enqueue(`: ${text}\n\n`);
    },
    end() {
      if (ending) return;
      ending = true;
      void chain.then(() => {
        markClosed();
        if (!res.destroyed && !res.writableEnded) res.end();
      });
    },
    get closed() {
      return closed;
    },
  };
}
