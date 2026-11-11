// Adapted from Rudy src/session/interrupted.ts (pi 1.4.0 lineage, MIT licensed).
// See src/compaction/NOTICE for the full license text.
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * 崩溃/中断恢复：找出日志尾部仍挂着 toolCall 却没有 toolResult 的
 * assistant 批次，为每个未完结调用合成一条 isError 的 toolResult。
 * 合成结果只标记"被打断、不会重跑"，不重新执行工具——已执行工具的
 * 副作用不可假设可重放。只处理尾部批次；更早的空洞按原样保留。
 */
export function closeInterrupted(messages: AgentMessage[]): AgentMessage[] {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    } else {
      pending.clear();
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "toolCall") pending.set(part.id, part.name);
        }
      }
    }
  }
  return [...pending].map(([toolCallId, toolName]) => ({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [
      {
        type: "text",
        text: "Tool execution was interrupted. The tool was not resumed.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  }));
}
