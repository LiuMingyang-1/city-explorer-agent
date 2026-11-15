"""Isolated local MediaCrawler entry point. Credentials are never command arguments.

--check imports the pinned CLI without accessing platform accounts.
--login opens a separate persistent browser for the user's normal login.
Search is headless and stops instead of attempting interactive login.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import logging
import os
from pathlib import Path
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[1]
PIN = "306ab4ca26c0e44fb87ede0e40e98748752815a6"
PLATFORMS = {
    "xhs": ("xhs", "XiaoHongShuLogin", "https://www.xiaohongshu.com"),
}
CLIENT_CLASSES = {
    "xhs": "XiaoHongShuClient", "dy": "DouYinClient", "ks": "KuaiShouClient",
    "bili": "BilibiliClient", "wb": "WeiboClient", "tieba": "BaiduTieBaClient",
}


class LoginRequired(RuntimeError):
    pass


def browser_executable(bundled: Path, platform: str = sys.platform, environ=None):
    """Use installed Playwright everywhere; Edge is a Windows-only fallback."""
    if bundled.is_file():
        return bundled
    if platform == "win32":
        env = os.environ if environ is None else environ
        edge = Path(env.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe"
        if edge.is_file():
            return edge
    return None


def private_path(value: str) -> Path:
    path = Path(value).resolve()
    if not path.is_relative_to(ROOT / ".local-data"):
        raise ValueError("PATH_MUST_BE_PRIVATE")
    return path


def bounded_items(response, limit: int):
    """Bound detail work, not just the number of exported documents."""
    if limit < 1 or limit > 5:
        raise ValueError("INVALID_SAMPLE_LIMIT")
    if isinstance(response, dict) and isinstance(response.get("items"), list):
        items = [item for item in response["items"] if isinstance(item, dict) and item.get("model_type") not in ("rec_query", "hot_query")]
        return {**response, "items": items[:limit]}
    return response


def bound_response(platform, response, limit):
    if not 1 <= limit <= 5:
        raise ValueError("INVALID_SAMPLE_LIMIT")
    if platform == "tieba":
        if not isinstance(response, list):
            raise ValueError("UNRECOGNIZED_SEARCH_RESPONSE")
        return response[:limit], len(response)
    key = {"xhs": "items", "dy": "data", "ks": "feeds", "bili": "result", "wb": "cards"}[platform]
    if not isinstance(response, dict) or not isinstance(response.get(key), list):
        raise ValueError("UNRECOGNIZED_SEARCH_RESPONSE")
    count = len(response[key])
    if platform == "xhs":
        return bounded_items(response, limit), count
    # Weibo cards can contain nested groups. Cap extracted posts in its core adapter.
    if platform == "wb":
        return response, count
    return {**response, key: response[key][:limit]}, count


def select_xhs_page(response, remaining, selected_ids):
    """Apply the total unique-detail quota across pages, before any detail IO."""
    if not 1 <= remaining <= 5:
        raise ValueError("INVALID_SAMPLE_LIMIT")
    if not isinstance(response, dict) or not isinstance(response.get("items"), list):
        raise ValueError("UNRECOGNIZED_SEARCH_RESPONSE")
    unique = []
    for item in response["items"]:
        if not isinstance(item, dict) or item.get("model_type") in ("rec_query", "hot_query"):
            continue
        note_id = item.get("id")
        if isinstance(note_id, str) and note_id and note_id not in selected_ids:
            unique.append(item)
            selected_ids.add(note_id)
            if len(unique) == remaining:
                break
    return {**response, "items": unique, "has_more": bool(unique) or bool(response.get("has_more"))}, len(response["items"])


async def main() -> int:
    started = time.perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--login", action="store_true")
    parser.add_argument("--verify-login", action="store_true", help="Check saved session without keyword search")
    parser.add_argument("--platform", choices=PLATFORMS)
    parser.add_argument("--keyword")
    parser.add_argument("--output")
    parser.add_argument("--limit", type=int, choices=range(1, 6), default=5)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    if not args.check and not args.platform:
        parser.error("--platform is required")
    if args.timeout < 10 or args.timeout > 600:
        parser.error("--timeout must be 10..600 seconds")
    if sum([args.check, args.login, args.verify_login]) > 1:
        parser.error("choose one of --check, --login, --verify-login")

    manifest = json.loads((ROOT / ".local-data/tools/mediacrawler-local.json").read_text(encoding="utf8"))
    if manifest["commit"] != PIN:
        raise ValueError("CRAWLER_VERSION_MISMATCH")
    source = private_path(manifest["directory"])
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(ROOT / ".local-data/tools/ms-playwright")
    sys.path.insert(0, str(source))
    os.chdir(source)  # Upstream uses relative libs/ and schema/ paths.

    import dotenv
    dotenv.load_dotenv = lambda *unused, **ignored: False
    # Do not let third-party imports discover this project's .env or inherit model keys.
    for name in list(os.environ):
        if name.endswith(("_API_KEY", "_KEY", "_TOKEN", "_SECRET")):
            os.environ.pop(name, None)
    logging.disable(logging.CRITICAL)
    from playwright.async_api import async_playwright, BrowserType, Page
    # If the Playwright CDN is unavailable, use installed Edge with our own profile.
    # Never connect to the user's existing browser session or remote debugging port.
    async with async_playwright() as playwright:
        bundled = Path(playwright.chromium.executable_path)
    executable = browser_executable(bundled)
    if executable is None:
        print('{"status":"browser_missing"}')
        return 2
    original_persistent = BrowserType.launch_persistent_context
    original_launch = BrowserType.launch

    async def persistent(browser_type, *positional, **kwargs):
        if browser_type.name == "chromium":
            kwargs.setdefault("executable_path", str(executable))
        return await original_persistent(browser_type, *positional, **kwargs)

    async def launch(browser_type, *positional, **kwargs):
        if browser_type.name == "chromium":
            kwargs.setdefault("executable_path", str(executable))
        return await original_launch(browser_type, *positional, **kwargs)

    BrowserType.launch_persistent_context = persistent
    BrowserType.launch = launch
    original_goto = Page.goto

    async def goto(page, url, **kwargs):
        # Weibo's continuous resource loading can prevent the full load event.
        # Wait for the initial document; subsequent account/API checks remain required.
        if url.startswith("https://www.weibo.com"):
            kwargs.setdefault("wait_until", "domcontentloaded")
        return await original_goto(page, url, **kwargs)

    Page.goto = goto

    profile = ROOT / ".local-data/tools/profiles" / f"{args.platform}_user_data_dir"
    if args.login:
        async with async_playwright() as playwright:
            context = await playwright.chromium.launch_persistent_context(str(profile), headless=False)
            try:
                page = context.pages[0] if context.pages else await context.new_page()
                await page.goto(PLATFORMS[args.platform][2], wait_until="domcontentloaded", timeout=30000)
                print("Complete normal login, then close this dedicated browser window. No password or Cookie is printed.", flush=True)
                closed = asyncio.get_running_loop().create_future()
                context.on("close", lambda unused: closed.set_result(None) if not closed.done() else None)
                await asyncio.wait_for(closed, 600)
            finally:
                await context.close()
        print(json.dumps({"status": "login_session_saved", "platform": args.platform}))
        return 0

    import config
    config.ENABLE_CDP_MODE = False
    config.CDP_CONNECT_EXISTING = False
    config.HEADLESS = True
    config.SAVE_LOGIN_STATE = True
    config.USER_DATA_DIR = str(ROOT / ".local-data/tools/profiles/%s_user_data_dir")
    config.ENABLE_GET_COMMENTS = False
    config.ENABLE_GET_SUB_COMMENTS = False
    config.ENABLE_GET_MEDIA = False
    config.ENABLE_IP_PROXY = False
    config.COOKIES = ""
    config.MAX_CONCURRENCY_NUM = 1
    # Upstream requests a fixed 20-item page. Only up to 5 unique details are
    # selected; the task-level four-keyword plan provides 20 requested notes.
    crawl_page_budget = 20
    config.CRAWLER_MAX_NOTES_COUNT = crawl_page_budget
    config.SAVE_DATA_OPTION = "jsonl"
    config.CRAWLER_MAX_SLEEP_SEC = 3
    import main as crawler

    if args.check:
        print(json.dumps({"status": "ready", "commit": PIN, "platforms": list(PLATFORMS), "browser_installed": True,
                          "browser": "bundled" if executable == bundled else "isolated_edge"}))
        return 0

    if not args.verify_login and (not args.keyword or not args.output):
        parser.error("search requires --keyword and --output")
    if not profile.exists():
        raise LoginRequired()
    destination = None
    if not args.verify_login:
        destination = private_path(str(ROOT / args.output))
        destination.mkdir(parents=True, exist_ok=False)
        config.SAVE_DATA_PATH = str(destination)

    auth = {"observed": False, "accepted": False, "search_skipped": False}
    if args.verify_login:
        client_module = importlib.import_module(f"media_platform.{PLATFORMS[args.platform][0]}.client")
        client_class = getattr(client_module, CLIENT_CLASSES[args.platform])
        original_pong = client_class.pong

        async def observed_pong(client, *positional, **kwargs):
            result = await original_pong(client, *positional, **kwargs)
            auth["observed"] = True
            auth["accepted"] = bool(result)
            return result

        async def skip_search(unused):
            auth["search_skipped"] = True

        client_class.pong = observed_pong
        crawler.CrawlerFactory.CRAWLERS[args.platform].search = skip_search

    metrics = {"search_calls": 0, "returned_items": 0, "search_errors": 0, "selected_items": 0}
    selected_ids = set()
    sort = "upstream_default"
    if not args.verify_login:
        config.SORT_TYPE = "time_descending"
        config.WEIBO_SEARCH_TYPE = "real_time"
        config.BILI_SEARCH_MODE = "normal"
        config.PUBLISH_TIME_TYPE = 7
        module_name = PLATFORMS[args.platform][0]
        client_module = importlib.import_module(f"media_platform.{module_name}.client")
        client_class = getattr(client_module, CLIENT_CLASSES[args.platform])
        method = {"xhs": "get_note_by_keyword", "dy": "search_info_by_keyword", "ks": "search_info_by_keyword_v2",
                  "bili": "search_video_by_keyword", "wb": "get_note_by_keyword", "tieba": "get_notes_by_keyword"}[args.platform]
        original_search = getattr(client_class, method)
        if args.platform in ("xhs", "dy", "bili", "wb", "tieba"):
            sort = "latest"
        if args.platform == "wb":
            core = importlib.import_module("media_platform.weibo.core")
            original_filter = core.filter_search_result_card
            core.filter_search_result_card = lambda cards: original_filter(cards)[:args.limit]

        async def bounded_search(client, *positional, **kwargs):
            search_budget = 1
            remaining = args.limit - metrics["selected_items"]
            if args.platform == "xhs" and (remaining <= 0 or metrics["search_calls"] >= search_budget):
                return {"items": [], "has_more": False}
            if metrics["search_calls"] >= search_budget:
                raise RuntimeError("SAMPLE_SEARCH_LIMIT")
            metrics["search_calls"] += 1
            if args.platform == "dy":
                field = importlib.import_module("media_platform.douyin.field")
                kwargs["sort_type"] = field.SearchSortType.LATEST
            elif args.platform == "bili":
                field = importlib.import_module("media_platform.bilibili.field")
                kwargs["order"] = field.SearchOrderType.LAST_PUBLISH
                kwargs["pubtime_begin_s"] = int(time.time()) - 30 * 86400
                kwargs["pubtime_end_s"] = int(time.time())
            elif args.platform == "tieba":
                kwargs["page_size"] = args.limit
            try:
                response = await original_search(client, *positional, **kwargs)
                response, count = select_xhs_page(response, remaining, selected_ids) if args.platform == "xhs" else bound_response(args.platform, response, args.limit)
                metrics["returned_items"] += count
                if args.platform == "xhs":
                    metrics["selected_items"] += len(response["items"])
                return response
            except Exception:
                metrics["search_errors"] += 1
                raise

        setattr(client_class, method, bounded_search)

    async def stop_interactive_login(self):
        raise LoginRequired()

    module, class_name, _ = PLATFORMS[args.platform]
    login_module = importlib.import_module(f"media_platform.{module}.login")
    getattr(login_module, class_name).begin = stop_interactive_login
    sys.argv = [str(source / "main.py"), "--platform", args.platform,
                "--type", "search", "--keywords", args.keyword or "login-check-no-search",
                "--headless", "true", "--get_comment", "false",
                "--get_sub_comment", "false", "--get_media", "false",
                "--save_data_option", "jsonl", "--save_data_path", str(destination or ROOT / ".local-data/tools/login-checks"),
                "--crawler_max_notes_count", str(crawl_page_budget), "--max_concurrency_num", "1"]
    try:
        await asyncio.wait_for(crawler.main(), args.timeout)
    finally:
        await asyncio.wait_for(crawler.async_cleanup(), 20)
    if args.verify_login:
        if not all(auth.values()):
            raise LoginRequired()
        local_basis = args.platform in ("dy", "tieba")
        report = {"status": "login_state_detected" if local_basis else "login_verified",
                  "platform": args.platform, "basis": "local_browser_state" if local_basis else "upstream_account_check",
                  "elapsed_ms": round((time.perf_counter() - started) * 1000), "keyword_searches": 0}
        state = ROOT / ".local-data/tools/login-checks"
        state.mkdir(parents=True, exist_ok=True)
        (state / f"{args.platform}.json").write_text(json.dumps(report, indent=2), encoding="utf8")
        print(json.dumps(report))
        return 0
    exported = sum(sum(1 for line in path.read_text(encoding="utf8").splitlines() if line.strip())
                   for path in destination.rglob("*contents*.jsonl"))
    status = ("search_failed" if metrics["search_errors"] else "search_not_executed" if not metrics["search_calls"]
              else "documents_exported" if exported else "detail_failed" if metrics["returned_items"] else "no_results")
    report = {"status": status, "platform": args.platform,
              "elapsed_ms": round((time.perf_counter() - started) * 1000),
              "keyword": args.keyword, "requested_limit": args.limit,
              "sort": sort, "exported_documents": exported, **metrics,
              "note": "Import and content checks are still required; exit zero does not verify coverage."}
    assert destination is not None
    (destination / "run.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if status in ("documents_exported", "no_results") else 6


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except LoginRequired:
        print('{"status":"login_required"}')
        sys.exit(3)
    except (TimeoutError, asyncio.TimeoutError):
        print('{"status":"timeout"}')
        sys.exit(4)
    except ModuleNotFoundError as error:
        print(json.dumps({"status": "dependency_missing", "module": error.name}))
        sys.exit(5)
    except Exception as error:
        # Upstream exceptions may include signed URLs; do not print traceback or message.
        frames = [{"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name}
                  for frame in traceback.extract_tb(error.__traceback__)[-5:]]
        print(json.dumps({"status": "crawler_failed", "error_type": type(error).__name__, "frames": frames}))
        sys.exit(1)
