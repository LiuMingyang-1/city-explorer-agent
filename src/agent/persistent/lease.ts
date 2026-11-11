import type { SessionRepository } from "../../session/repository.ts";
import type { LeaseWriter } from "../../session/types.ts";

export interface LeaseGuardOptions {
  repo: SessionRepository;
  userId: string;
  /** 惰性取会话 ID：构造时主会话可能尚未建立。 */
  sessionId: () => string;
  owner: string;
  ttlMs: number;
  renewMs: number;
  /** 租约失效/写失败闩锁触发时回调（runtime 用来 abort 在途运行）。 */
  onDead: (error: Error) => void;
}

/**
 * 会话写租约守卫：busy 窗口内 acquire → 心跳续期 → finally 释放；
 * 空闲立即释放，不把租约永久占在 idle。epoch fencing 由仓库层保证，
 * 本类只管"活着时续、失效即闩锁禁写并通知宿主中止"。
 */
export class LeaseGuard {
  private readonly options: LeaseGuardOptions;
  private writer: LeaseWriter | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  /** 失败闩锁：置位后本写窗口拒绝一切写入，直到下一个窗口清闩。 */
  private latch: Error | undefined;

  constructor(options: LeaseGuardOptions) {
    this.options = options;
  }

  get current(): LeaseWriter | undefined {
    return this.writer;
  }

  get failure(): Error | undefined {
    return this.latch;
  }

  /** 上闩并通知宿主（abort 在途运行），错误原样保留。 */
  fail(error: unknown): void {
    this.latch = error instanceof Error ? error : new Error(String(error));
    this.options.onDead(this.latch);
  }

  /**
   * 写路径统一入口：闩锁置位或未持租约时直接拒绝；op 失败则上闩并
   * 通知宿主中止运行，错误继续抛给调用方。
   */
  async guarded<T>(op: (writer: LeaseWriter) => Promise<T>): Promise<T> {
    if (this.latch) throw this.latch;
    const writer = this.writer;
    if (!writer) throw new Error("会话写租约未持有");
    try {
      return await op(writer);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /** 一个写窗口：acquire → 心跳 → op → 停心跳 → 释放（epoch 防误放）。 */
  async run<T>(op: () => Promise<T>): Promise<T> {
    const { repo, userId, owner, ttlMs } = this.options;
    const writer = await repo.acquireLease(userId, this.options.sessionId(), owner, ttlMs);
    if (!writer) {
      throw new Error("会话正由另一个写者处理（写租约未释放），请稍后重试");
    }
    this.writer = writer;
    this.latch = undefined; // 新写窗口：上一轮失败闩锁不带入
    this.startHeartbeat();
    try {
      return await op();
    } finally {
      await this.release();
    }
  }

  /** 停心跳并尽力释放当前租约；WHERE 带 owner+epoch，不会误放已易主的租约。 */
  async release(): Promise<void> {
    this.stopHeartbeat();
    const held = this.writer;
    this.writer = undefined;
    if (held) {
      const { repo, userId } = this.options;
      await repo.releaseLease(held, userId, this.options.sessionId()).catch(() => {});
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      void this.renewOnce();
    }, this.options.renewMs);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private async renewOnce(): Promise<void> {
    const writer = this.writer;
    if (!writer) return;
    try {
      const ok = await this.options.repo.renewLease(
        writer,
        this.options.userId,
        this.options.sessionId(),
        this.options.ttlMs,
      );
      if (!ok) this.fail(new Error("会话写租约续期失败：租约已过期或被接管"));
    } catch (error) {
      this.fail(error);
    }
  }
}
