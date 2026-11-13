/**
 * Web 入口装配：loadConfig → 活动库存在且非空 → 打开活动库与会话库 →
 * createChatService → createChatHandler → createWebServer 同源托管 frontend/，
 * 并把 /api/chat* 转给 Chat HTTP 协议层。
 *
 * 缺库/空库只提示 npm run seed，绝不自动写入（与 CLI 入口同口径）；
 * SIGINT/SIGTERM 走 createShutdown 编排：先发起 server.close 停接新连接，
 * await service.shutdown()（拒新请求、取消并等在途 send/history——含
 * Planner.close/租约释放——结清），再确认连接耗尽，最后关两个库；
 * 重复信号/异常也只执行一次，关库不早于在途 Planner.close。
 *
 * 运行：npm run dev:web（内部 node --env-file-if-exists=.env src/web/main.ts）。
 * 监听 EXPLORER_WEB_HOST/PORT（默认 127.0.0.1:8080），跨域白名单
 * EXPLORER_WEB_ALLOWED_ORIGINS，静态根 EXPLORER_WEB_ROOT（默认 frontend/）。
 * 可选登录：启动时播种 EXPLORER_ADMIN_USER/EXPLORER_ADMIN_PASSWORD
 * （缺省 admin/admin，仅本地演示；全默认时 stderr 提示配置口令），
 * https 部署加 EXPLORER_SECURE_COOKIE=1 为登录 cookie 加 Secure。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.ts";
import { createSqliteSessionRepository } from "../session/sqlite.ts";
import { createAuthStore } from "./auth.ts";
import { createChatHandler } from "./http.ts";
import { createChatService } from "./service.ts";
import {
  assertEventsNonEmpty,
  createShutdown,
  createWebServer,
  listen,
  openEventsRepository,
  webListenOptions,
} from "./server.ts";

export async function main(): Promise<void> {
  const config = loadConfig();
  const options = webListenOptions();
  const repository = openEventsRepository(config);
  const sessionDbPath = config.sessionDbPath ?? resolve("data/sessions.db");
  const sessions = createSqliteSessionRepository(sessionDbPath);
  // 登录存储与会话库同文件：第二条连接（WAL + busy_timeout 共存）。
  const auth = createAuthStore(sessionDbPath);
  try {
    // 播种登录账号：该 username 无凭据行才建（已有则原样保留，不重置口令）。
    const adminUser = process.env.EXPLORER_ADMIN_USER?.trim() || "admin";
    const adminPassword = process.env.EXPLORER_ADMIN_PASSWORD || "admin";
    auth.ensureAccount({ username: adminUser, password: adminPassword });
    // 环境变量只负责首次播种；旧库仍用默认口令时不能因改了 env 而静默。
    if (auth.verifyLogin("admin", "admin") !== undefined) {
      console.warn(
        "[web] 登录账号正在使用默认口令 admin/admin。EXPLORER_ADMIN_PASSWORD 仅首次播种生效；已有账号须另行安全更新凭据。",
      );
    }
    await assertEventsNonEmpty(repository, config.dbPath);
    const service = createChatService({ config, repository, sessions });
    const server = createWebServer({
      staticRoot: options.staticRoot,
      apiHandler: createChatHandler(service, {
        allowedOrigins: options.allowedOrigins,
        auth,
        secureCookie: config.secureCookie,
      }),
    });
    await listen(server, options.host, options.port);
    process.stderr.write(
      `Web 入口已就绪：http://${options.host}:${options.port}/ ` +
        `（${config.provider}/${config.model}；活动库 ${config.dbPath}、` +
        `会话库 ${config.sessionDbPath ?? "data/sessions.db"}；匿名身份经 cookie）。\n`,
    );
    const shutdown = createShutdown({
      server,
      service,
      closeDbs: () => {
        auth.close();
        sessions.close();
        repository.close();
      },
    });
    const onSignal = (): void => {
      shutdown().catch((error: unknown) => {
        console.error("[web] shutdown failed:", error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  } catch (error) {
    auth.close();
    sessions.close();
    repository.close();
    throw error;
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
