import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createPersistentPlanner } from "../agent/session.ts";
import type { PlannerSession } from "../agent/session.ts";
import { loadConfig } from "../config.ts";
import { createEventRepository } from "../data/delivery.ts";
import { createSqliteSessionRepository } from "../session/sqlite.ts";
import type { CliIO } from "./loop.ts";
import { runTurns } from "./loop.ts";

const USAGE = `city-explorer-agent v0 — 用自然语言规划一日出行

用法（先 npm run seed 写入模拟活动，并在 .env 配好 EXPLORER_API_KEY）：
  npm run dev                             交互式 REPL，多轮自然语言修改行程
  npm run dev -- 周六下午想看展            单轮模式：参数拼成一条需求跑一次
  printf '周六下午看展\\n第二个换一个\\n' | npm run --silent dev
                                          批处理：stdin 每行一条需求，按顺序执行；
                                          机器解析 stdout 加 --silent 去掉 npm 横幅

会话：
  对话与已确认行程持久化在 SQLite 会话库（默认 data/sessions.db，
  EXPLORER_SESSION_DB_PATH 覆盖）。默认每次启动新建一条对话，
  启动时 stderr 打印本次会话 ID；设 EXPLORER_SESSION_ID=<id>
  可恢复指定会话（调试/回归用）。
  EXPLORER_USER_ID 是本地演示标识（缺省/空白 → local），不是 Web 认证。
  会话内命令：/compact 手动压缩上下文（不会发给模型）。

输出约定：
  stdout  每轮一个单行 JSON：行程对象，或 {"question": "..."} 追问（可 NDJSON 解析）
  stderr  输入提示、search_events 工具轨迹、错误信息；日志不含密钥
  输入 exit / quit / 退出，或 Ctrl+D 结束会话；
  Ctrl+C 在请求进行中取消本轮，空闲时退出

其他命令：
  npm run seed [-- --date=YYYY-MM-DD]     写入 119 条模拟活动（默认覆盖今天起 7 天；
                                        --date 固定生成基准日；重复执行会重建表数据）
  npm run check                           typecheck + 全部测试
  --help, -h                              显示本说明

不走 npm 脚本时用 node --env-file-if-exists=.env src/cli/main.ts …（裸 node 不读 .env）。
`;

/**
 * 命令行入口：读配置 → 打开活动库与会话库 → createPersistentPlanner →
 * 三种输入模式逐轮处理。stdout 只放每轮结果 JSON；提示、工具轨迹、错误
 * 走 stderr，不输出密钥。缺库/空库只提示 npm run seed，绝不自动写入；
 * 退出时 finally 依次释放 planner（退订/停心跳/放租约）与两个 SQLite 连接。
 */
export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const config = loadConfig();
  if (!existsSync(config.dbPath)) {
    throw new Error(
      `活动库不存在：${config.dbPath}\n先运行 \`npm run seed\` 生成模拟活动数据。`,
    );
  }
  const repository = createEventRepository(config.dbPath);
  const sessions = createSqliteSessionRepository(
    config.sessionDbPath ?? resolve("data/sessions.db"),
  );
  let planner: PlannerSession | undefined;
  try {
    const probe = await repository.search({});
    if (probe.length === 0) {
      throw new Error(
        repository.collectionDelivery
          ? `采集交付库当前没有可发现的活动（全部未通过新鲜度核验）：${config.dbPath}`
          : `活动库为空：${config.dbPath}\n运行 \`npm run seed\` 写入模拟活动（会重建 events 表数据）。`,
      );
    }
    planner = await createPersistentPlanner({
      config,
      repository,
      sessions,
      userId: config.userId ?? "local",
      sessionId: config.sessionId,
    });
    const io: CliIO = {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    };
    io.err(
      `已连接 ${config.provider}/${config.model}；活动库 ${config.dbPath}、` +
        `会话库 ${config.sessionDbPath ?? "data/sessions.db"}` +
        `（${repository.collectionDelivery ? "采集交付的真实数据" : "内容为模拟数据"}；` +
          `本地用户 ${config.userId ?? "local"}）。`,
    );
    io.err(
      config.sessionId
        ? `已恢复会话 ${planner.sessionId}。`
        : `本次新对话会话 ${planner.sessionId}；` +
            `恢复请设 EXPLORER_SESSION_ID=${planner.sessionId}。`,
    );

    const inline = argv.join(" ").trim();
    if (inline) {
      await runTurns(planner, [inline], io);
      return;
    }
    const interactive = process.stdin.isTTY === true;
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr, // 交互提示与回显走 stderr，stdout 只放行程 JSON
      terminal: interactive,
    });
    // Ctrl+C：请求进行中 → 取消本轮（不退出）；空闲 → 正常结束。
    rl.on("SIGINT", () => {
      if (planner !== undefined && planner.busy) planner.cancel();
      else rl.close();
    });
    if (interactive) {
      io.err("逐行输入出行需求；exit/quit/退出 或 Ctrl+D 结束，/compact 手动压缩。");
      io.afterTurn = () => rl.prompt();
      rl.prompt();
    }
    await runTurns(planner, rl, io);
  } finally {
    await planner?.close();
    sessions.close();
    repository.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
