# SymHarix 发行与安装设计

## 调研结论

SymHarix 采用“可下载便携包 + 一行安装器 + 保留源码安装”的双轨方式。这与成熟开源开发工具的共同做法一致：

| 项目 | 官方分发方式 | SymHarix 采用的部分 |
| --- | --- | --- |
| [OpenCode](https://github.com/anomalyco/opencode) | GitHub Release 多平台二进制、`curl | bash`、Homebrew/Scoop、桌面包 | Release 资产命名、终端安装、用户级目录、平台探测 |
| [Bun](https://bun.sh/docs/installation) | 一行安装脚本、GitHub Release 直接下载、单文件运行时 | 每个 SymHarix 包内置对应平台 Bun，不要求全局安装 |
| [Deno](https://docs.deno.com/runtime/getting_started/installation/) | Shell/PowerShell 安装器下载 Release、解压并替换版本 | POSIX 与 PowerShell 两套安装器、版本化安装目录 |
| [Ollama](https://www.ollama.com/download) | Linux 安装脚本，macOS/Windows 下载应用，后台升级 | 终端入口先行，桌面安装器作为后续产品层 |

第一阶段不急于加入 Electron/Tauri。SymHarix 已有 Runtime Deck 和完整终端配置流，先消除 Bun/Node、源码目录、依赖安装和升级覆盖配置这些障碍，能更快得到可验证的低门槛发行版本。

## 发行资产

每个 Git tag 的 GitHub Release 由原生 runner 构建：

- `symharix-darwin-arm64.tar.gz`
- `symharix-darwin-x64.tar.gz`
- `symharix-linux-x64.tar.gz`
- `symharix-linux-arm64.tar.gz`
- `symharix-windows-x64.zip`
- `symharix-windows-arm64.zip`
- `checksums.txt`

包内包含对应平台的 Bun、生产依赖、SymHarix 源码运行资源、OpenCode 版本锁和配置模板。OpenCode 本体仍在首次配置/启动时按锁文件下载，并验证官方 Release 的 SHA-256，避免将未经兼容测试的新版本自动带入。

Windows x64/ARM64 的 OpenCode 资产已经进入同一锁文件；自动 Release 在 GitHub 提供的原生 hosted runner 上分别验证并构建两个架构。

## 安装方式

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/UniUni2000/SymHarix/main/install.sh | sh
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/UniUni2000/SymHarix/main/install.ps1 | iex
```

### 本地下载

1. 从 GitHub Releases 下载与操作系统匹配的包和 `checksums.txt`。
2. 使用 `shasum -a 256`、`sha256sum` 或 PowerShell `Get-FileHash` 校验。
3. 解压后执行 `SymHarix/bin/symharix`；Windows 执行 `SymHarix\bin\symharix.cmd`。
4. 不带参数时默认进入配置向导。

## 目录与升级边界

程序和用户数据严格分开：

```text
用户级安装目录/
  current-version
  versions/
    1.0.0/                 # 只读程序、内置 Bun、依赖和模板

~/.symharix/               # 可用 SYMHARIX_HOME 覆盖
  .env
  WORKFLOW.md
  symharix.db
  .venv/
  .runtime-cache/opencode/
  workspaces/
```

重新运行安装脚本就是升级路径：新版本进入新的版本目录，通过全部安装步骤后才更新 `current-version`。旧版本文件不会与 `.env`、数据库或工作区混放，因此程序升级不会表现为“配置丢失”。

## 安全与失败策略

- 安装器下载发行包和 `checksums.txt`，SHA-256 不一致立即停止。
- 包中禁止包含 `.env`、实际 `WORKFLOW.md`、数据库、缓存、测试文件或 Python bytecode。
- Git 和 Python 3 在下载前检查；安装器不会静默使用系统管理员权限安装它们。
- Python 依赖安装到 `~/.symharix/.venv`，不污染系统 Python。
- Bun 包含在发行包中；`node` 命令由包内 Bun 兼容入口提供。
- OpenCode 继续使用锁版本、资产哈希、最低兼容版本和真实 runtime check。
- 配置向导最终预检通过前不写入本轮凭据和路由。

## GitHub Actions 门禁

`.github/workflows/release.yml` 在 tag 发布前执行：

1. TypeScript、全部隔离测试、构建、OpenCode runtime 检查；
2. macOS ARM64/x64、Linux ARM64/x64、Windows ARM64/x64 原生打包；
3. 在每个平台真实运行包内 `symharix version` 与 `symharix help`；
4. 汇总计算 `checksums.txt`；
5. 只在全部平台成功后创建 GitHub Release 并上传资产。

后续桌面版可以复用同一用户数据目录和命令入口，Tauri 只负责窗口、托盘、图形化配置与签名安装器，不需要重写后端运行模型。
