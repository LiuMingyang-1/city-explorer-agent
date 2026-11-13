# 采集跨平台部署与定时运行

对应 [Issue #11](https://github.com/LiuMingyang-1/city-explorer-agent/issues/11)。以下入口共用同一采集逻辑、校验和data/events.db，不更改数据契约，不自动安装或启用生产任务。

## 环境矩阵

|项目|Windows|Linux（Ubuntu 24.04）|macOS|
|---|---|---|---|
|Node|package.json要求>=22.19，推荐24 LTS|同左|同左|
|Python|>=3.11，推荐3.12|同左；venv可能需python3-venv|同左|
|默认解释器|.local-data/tools/mediacrawler-venv/Scripts/python.exe|.local-data/tools/mediacrawler-venv/bin/python|同Linux|
|只做DeepSeek、关闭OCR|不需要Python依赖|同左|同左|
|本地图片OCR|scripts/requirements-ocr.txt|同左；OpenCV可能需libgl1/libglib2.0-0|同左|
|小红书|固定版本MediaCrawler和Playwright；Chromium缺失时可回退本机Edge|固定版本MediaCrawler和Playwright Chromium；Linux需浏览器系统依赖|固定版本MediaCrawler和Playwright Chromium|
|首次平台登录|专用有界面浏览器|需图形会话；无桌面服务器需先准备受支持的浏览器登录环境|专用有界面浏览器|
|后台调度|Windows任务计划程序，隐藏窗口|cron，标准输出重定向日志|cron；机器休眠时不保证触发|

Python解释器优先级：**JSON的python > 环境变量COLLECTION_PYTHON > 当前平台默认venv路径**。普通采集配置在顶层写python；任务配置写collection_defaults.python。相对路径以项目根目录为基准；裸命令如python3按PATH查找；含空格路径无需在JSON值内额外加引号，不支持在路径后拼接命令参数或shell表达式。

例如：

```json
"collection_defaults": {
  "python": "/srv/city-explorer-agent/.local-data/tools/mediacrawler-venv/bin/python"
}
```

上面只展示新增字段，应合并到现有collection_defaults，保留output_dir、processing等内容。也可在本机.env设置COLLECTION_PYTHON。预览模式不读.env、不启动Python、不调用API。

## 建立依赖

先在项目根目录执行npm ci。Windows创建环境：

```powershell
py -3.12 -m venv .local-data/tools/mediacrawler-venv
$python = '.local-data/tools/mediacrawler-venv/Scripts/python.exe'
& $python -m pip install -r scripts/requirements-ocr.txt
```

Linux/macOS：

```sh
python3 -m venv .local-data/tools/mediacrawler-venv
PYTHON="$PWD/.local-data/tools/mediacrawler-venv/bin/python"
"$PYTHON" -m pip install -r scripts/requirements-ocr.txt
```

Ubuntu缺少venv时先由部署者安装python3-venv。Linux OpenCV缺库时安装libgl1、libglib2.0-0。只用DeepSeek且关闭processing.ocr时，可以跳过整套Python安装。

小红书还需固定上游源码及依赖；下列为POSIX示例，Windows使用相同git命令、将python调用替换为上述$python：

```sh
mkdir -p .local-data/tools
git clone https://github.com/NanmiCoder/MediaCrawler.git .local-data/tools/MediaCrawler-306ab4ca26c0
git -C .local-data/tools/MediaCrawler-306ab4ca26c0 checkout --detach 306ab4ca26c0e44fb87ede0e40e98748752815a6
"$PYTHON" -m pip install -r docs/architecture/mediacrawler/mediacrawler-requirements.lock.txt
```

依赖锁是原Windows/Python3.12环境的版本记录，跨平台如缺对应wheel需在隔离环境核实兼容性，不能据此宣称所有平台安装成功。不更换上游commit来绕过兼容问题。

在.local-data/tools/mediacrawler-local.json保存以下清单，directory用当前机器路径或项目根目录下的相对路径：

```json
{
  "repository": "https://github.com/NanmiCoder/MediaCrawler",
  "commit": "306ab4ca26c0e44fb87ede0e40e98748752815a6",
  "directory": ".local-data/tools/MediaCrawler-306ab4ca26c0"
}
```

安装Playwright浏览器时，必须与脚本使用同一下载目录：

```sh
# Linux：--with-deps还需系统包安装权限；macOS去掉--with-deps。
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local-data/tools/ms-playwright" "$PYTHON" -m playwright install --with-deps chromium
"$PYTHON" scripts/mediacrawler-local.py --check
"$PYTHON" scripts/mediacrawler-local.py --login --platform xhs
"$PYTHON" scripts/mediacrawler-local.py --verify-login --platform xhs --timeout 60
```

Windows在PowerShell先设置$env:PLAYWRIGHT_BROWSERS_PATH为项目的.local-data/tools/ms-playwright，再运行`& $python -m playwright install chromium`。原有独立Edge回退保留，Linux/macOS不再尝试Windows Edge路径。

账号、Cookie仅来自用户正常登录，保存在.local-data/tools/profiles/xhs_user_data_dir，不读取个人日常浏览器、不把登录态提交Git。不保证Windows浏览器profile直接复制到Linux/macOS后可用；系统加密和浏览器版本可能不同。生产后台只无头采集，登录失效停止并记录XHS_LOGIN_REQUIRED，不在cron中弹二维码或交互登录。

API配置沿用本机.env中的DEEPSEEK_API_KEY、EXPLORER_COLLECTION_MODEL、AMAP_WEB_KEY，不写入配置JSON或crontab。非交互运行也要确保同一操作系统用户能读取.env、数据库和本地资料目录。

## 每晚23点静默执行

在configs/collection.scheduled.json中设置：

```json
"schedule": {
  "enabled": true,
  "backend": "cron",
  "task_name": "CityExplorerNightlyDiscovery",
  "poll_minutes": 5,
  "at": "23:00",
  "weekdays": [1, 2, 3, 4, 5, 6, 7],
  "search_anchor_day_offset": 1,
  "catch_up_window_minutes": 120,
  "max_run_minutes": 60
}
```

先预览（不联网、不启动搜索、不写任务状态）：

```sh
npm run collect -- --config configs/collection.example.json
npm run collect:task -- --config configs/collection.scheduled.json
sh scripts/collection-scheduled-task.sh --config configs/collection.scheduled.json
```

由部署者执行mkdir -p .local-data/xian/scheduled，再通过crontab -e添加以下内容；项目和Node绝对路径按实际安装修改，PATH必须包含Node供上游签名脚本使用：

```cron
PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
*/5 * * * * cd /srv/city-explorer-agent && NODE_BINARY=/opt/node/bin/node /bin/sh scripts/collection-scheduled-task.sh --config configs/collection.scheduled.json --live >> .local-data/xian/scheduled/cron.log 2>&1
```

这是每5分钟**检查一次资格**，不是每5分钟采集一次。业务时间由Node按Asia/Shanghai判断，因此宿主机时区为UTC也可使用，不依赖CRON_TZ。23:00—23:05通常开始当天唯一一轮；错过后最多允许120分钟内补跑。机器停止、休眠、断网或cron服务未运行时不保证触发。

cron行的频率由crontab决定，修改JSON的poll_minutes不会修改crontab。外层包装脚本会切换到项目目录并保留所有带空格参数；NODE_BINARY允许指定Node绝对路径。脚本不安装任务、不修改系统cron，不打开浏览器窗口。

Windows继续使用backend=windows_task_scheduler及原PowerShell安装器；它会拒绝安装cron配置。POSIX包装脚本实际运行时也拒绝Windows后端配置。backend=manual表示只允许显式`--manual --live`启动；自动调用返回跳过。

正常每天最多尝试一次，失败也不会在下个心跳重跑整批；成功完整运行才推进词库游标。两个后端都使用同一个数据库任务锁，防止重复唤起并发写库。不要在crontab里加--manual或--force，否则会绕过正常时间/每日资格设计，程序会拒绝将--backend与--manual合用。

默认搜索规模仍是小红书4词×5篇、DeepSeek4词×5篇；通过校验和去重后原地写data/events.db。任务状态及逐轮诊断在.local-data/xian/scheduled。partial不等于数据库没有写入，退出码2表示部分失败，1表示失败。

## 本地验证与CI

```sh
npm run typecheck
node --test --test-timeout=30000 "test/collection-*.test.ts" test/unified-events.test.ts
"$PYTHON" -m unittest discover -s test -p test_mediacrawler_local.py
COLLECTION_PYTHON="$PYTHON" node scripts/check-collection-runtime.ts --ocr
COLLECTION_PYTHON="$PYTHON" node scripts/check-collection-runtime.ts --crawler
```

运行环境检查不会调用采集API或搜索平台账号。--ocr会实际启动Python、导入RapidOCR并初始化模型，用被禁止的图片域名验证本地处理和无网络行为；--crawler验证已准备的固定上游和浏览器。缺依赖时失败并提示检查环境，不自动安装。

.github/workflows/collection-portability.yml在Windows、Ubuntu和macOS上运行类型检查、采集回归、Python边界测试、真实OCR运行检查和POSIX入口预览；不注入API Key、不携带Cookie、不执行生产采集。真实平台搜索还受账号、网络和上游接口影响，不能由离线CI保证。
