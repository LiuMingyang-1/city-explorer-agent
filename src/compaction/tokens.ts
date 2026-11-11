// Adapted from Rudy src/compaction/tokens.ts (pi 1.4.0 lineage, MIT licensed).
// See NOTICE in this directory for the full license text.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

export interface UsageBaseline {
  estimate(messages: AgentMessage[], model: Model<Api>): number;
  observe(message: AgentMessage, contextMessages: AgentMessage[], model: Model<Api>): void;
  clear(): void;
}

export function createUsageBaseline(): UsageBaseline {
  let usageBase: { messages: AgentMessage[]; model: string; tokens: number } | undefined;
  return {
    estimate(messages, model) {
      if (
        usageBase &&
        usageBase.model === modelKey(model) &&
        usageBase.messages.every((message, index) => messages[index] === message)
      ) {
        return usageBase.tokens + estimateMessages(messages.slice(usageBase.messages.length));
      }
      return estimateMessages(messages);
    },
    observe(message, contextMessages, model) {
      if (
        message.role === "assistant" &&
        message.stopReason !== "error" &&
        message.stopReason !== "aborted"
      ) {
        const { input, output, cacheRead, cacheWrite } = message.usage;
        const tokens = input + output + cacheRead + cacheWrite;
        if (input + cacheRead + cacheWrite > 0 && tokens > 0)
          usageBase = { messages: [...contextMessages], model: modelKey(model), tokens };
      }
    },
    clear() {
      usageBase = undefined;
    },
  };
}

export function estimateText(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other * 1.5);
}

export function estimateMessage(message: AgentMessage): number {
  return 8 + estimateText(serializeMessage(message));
}

export function serializeMessage(message: AgentMessage): string {
  // Include content, tool arguments/declarations, sections and structural overhead,
  // without counting billing metadata or provider response identifiers.
  const { role, content } = message;
  return JSON.stringify({
    role,
    content,
    ...(role === "system"
      ? {
          sections: message.sections,
          toolsAdded: message.toolsAdded,
          toolsRemoved: message.toolsRemoved,
        }
      : role === "toolResult"
        ? { toolCallId: message.toolCallId, toolName: message.toolName }
        : {}),
  });
}

export function estimateMessages(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessage(message), 0);
}

/** Keep a continuous suffix, treating an assistant/tool-result batch as one unit. */
export function recentStart(messages: AgentMessage[], target: number): number {
  const units: { start: number; tokens: number }[] = [];
  for (let index = 0; index < messages.length; index++) {
    const start = index;
    const message = messages[index];
    if (!message) continue;
    let tokens = estimateMessage(message);
    if (message.role === "assistant" && message.content.some((part) => part.type === "toolCall")) {
      while (messages[index + 1]?.role === "toolResult") {
        index++;
        const result = messages[index];
        if (result) tokens += estimateMessage(result);
      }
    }
    units.push({ start, tokens });
  }
  let start = messages.length;
  let tokens = 0;
  for (const unit of units.reverse()) {
    if (tokens + unit.tokens >= target * 1.2) break;
    tokens += unit.tokens;
    start = unit.start;
    if (tokens >= target) break;
  }
  return start;
}

function modelKey(model: Model<Api>): string {
  return JSON.stringify([
    model.provider,
    model.id,
    model.api,
    model.baseUrl,
    model.contextWindow,
    model.maxTokens,
  ]);
}
