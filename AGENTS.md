# 通用指令

## 开发规范

### 沟通与交付

1. 用中文交流，代码注释也用中文，专业名词除外
2. 非用户主动要求，不要写总结文档

### 实现方式

1. 初次实现功能时减少 try except，以实现核心功能为主
2. 每当遇到你对代码不自信的地方时，在代码中添加TODO注释
3. 每当你或者用户让你跳过某些重要实现时，在代码中添加TODO注释
4. 每当你执行兼容性写法时，在代码中添加TODO注释
5. 尽量避免使用any类型，除非遇到泛型等复杂情况，可以保留any
6. 能用第三方库就添加并使用第三方库，不要重复造轮子
7. 类：禁止原型混入/变异。优先继承/组合
8. 除非代码附近有注释，否则不要保留任何兼容性代码

### 依赖与配置

1. 不要在代码中给环境变量添加硬编码参数，
2. 使用 `uv` 管理 Python 环境和依赖。通过 `uv run` 执行 Python 命令，通过 `uv add`/`uv remove` 管理依赖。
3. 虚环境位于 `.venv/`，已加入 `.gitignore`。首次使用运行 `uv sync` 创建。
4. 懒加载的包单独放 runtime 模块里

### 运行与质量

1. 每次编写代码文件都要通过静态分析
2. 遇到疑似没用到的代码、冗余

### 代码组织

1. package.json中指令过长，则写入scrips的.mjs脚本中
2. 仓库中js代码统一使用 ESM (ES Modules)，使用 `import`/`export` 语法，避免 CommonJS
3. 使用 `bun` 管理 JS/TS 依赖和运行脚本。通过 `bun add`/`bun remove` 管理依赖，`bun run` 执行脚本。

### 提交与目录规范

1. git提交：常规风格、简洁、分组。
2. 创建的每个子目录必须包含 AGENTS.md 文件，包含'目录作用'、'可以修改'、'不要修改'、'约定'四部分指令。

### 失败处理

1. 程序永远不要静默失败。

## 项目专属

### 配置

### 项目范围

### 前端目录

### 后端目录

## Agent 协作

### 协作方式

1. 本项目全程由vibe coding生成，agent上下文有限，智力有限，所以一旦遇到不符合开发规范的地方要积极举手告知用户

### 环境配置

1. 开发任务中遇到环境配置的问题，优先跳过然后实现其它部分，最后询问用户来配置，不要瞎改环境配置。
2. 安装环境时不要考虑手动编译，充分搜索相关预编译包，如何还是找不到，通知用户。

## 额外

### 用户根据agent反馈手动添加的尚未整理的额外指令

1. 模板示例，整理AGENTS.md时保留这行



# AGENTS.md

This project is a VS Code extension template focused on Webview UI development with automated E2E observation reports.

## First Commands

Run from this directory:

```bash
npm install
npm run compile
npm run e2e
npm run e2e:trace
npm run artifacts:latest
```

In this sandbox, WDIO/Chromedriver may need elevated permissions because it binds localhost ports. In normal local development, `npm run e2e` should be enough.

## Extension Architecture

Core extension code lives in `src/`:

- `src/extension.ts`: VS Code activation entry. Keep this thin.
- `src/extensionController.ts`: command registration, TreeView registration, state dump, startup restore orchestration.
- `src/workspaceTerminalManager.ts`: workspace terminal tracking, periodic save, restore, and TreeView data.
- `src/tmuxService.ts` / `src/zellijService.ts`: backend command execution and session parsing.
- `src/tmuxTreeProvider.ts` / `src/zellijTreeProvider.ts`: native TreeView presentation.
- `src/constants.ts`: extension IDs, view IDs, command IDs, configuration section, and workbench command names.
- `src/types.ts`: shared state and backend contracts.
- `src/diagnosticLogger.ts`: extension-side JSONL logger and Output Channel mirroring.

The intended dependency direction is:

```text
extension.ts -> extensionController.ts -> workspaceTerminalManager.ts
                                   -> tmuxTreeProvider.ts -> tmuxService.ts
                                   -> zellijTreeProvider.ts -> zellijService.ts
                                   -> diagnosticLogger.ts
                                   -> constants.ts/types.ts
```

Avoid moving business logic back into `extension.ts`.

## VS Code Contributions

`package.json` declares the public extension surface:

- Activity Bar container: `terminalManager`
- TreeViews:
  - `vscodeTerminalManager.workspace`
  - `vscodeTerminalManager.zellij`
  - `vscodeTerminalManager.tmux`
- Main commands:
  - `vscode-terminal-manager.openSidebar`
  - `vscode-terminal-manager.refreshAll`
  - `vscode-terminal-manager.dumpState`
  - `vscode-terminal-manager.workspace.*`
  - `vscode-terminal-manager.zellij.*`
  - `vscode-terminal-manager.tmux.*`

When changing public IDs, update `package.json`, `src/constants.ts`, and `test/e2e/support/extension-contract.mjs` together.

## Terminal State

The workspace terminal manager uses VS Code terminal APIs:

- `window.onDidOpenTerminal`, `onDidCloseTerminal`, `onDidChangeTerminalState`, and `onDidChangeActiveTerminal` keep the workspace tree current.
- `onDidChangeTerminalShellIntegration`, `onDidStartTerminalShellExecution`, and `onDidEndTerminalShellExecution` capture cwd and tmux/zellij command observations when shell integration is available.
- `Terminal.creationOptions.location` is saved to distinguish panel/editor creation location. VS Code does not expose a live "moved after creation" terminal location field.
- Saved state is stored in `context.workspaceState` under `workspaceTerminalSnapshots`.

## Development Tools

VS Code one-click debug:

- Open this folder in VS Code.
- Run and Debug: `Debug VS Code Terminal Manager Extension`.
- F5 runs `npm run compile`, then starts an isolated Extension Development Host.

Command-line dev host:

```bash
npm run start
```

E2E:

```bash
npm run e2e
npm run e2e:trace
npm run e2e:debug
```

Trace output can be opened with:

```bash
npx playwright show-trace <trace.zip>
```

## E2E Test Layout

E2E files:

- `wdio.conf.mjs`: base WDIO + `wdio-vscode-service` config.
- `wdio.trace.conf.mjs`: trace mode using `@wdio/devtools-service`.
- `wdio.debug.conf.mjs`: live DevTools mode.
- `test/e2e/specs/sidebar.e2e.mjs`: TreeView and backend state tests.
- `test/e2e/support/diagnostics.mjs`: UI snapshot, logs, artifacts.
- `test/e2e/support/extension-contract.mjs`: command IDs used by E2E tests.
- `test/e2e/support/wdio-config.mjs`: shared WDIO config helpers.

Important helpers:

- `openSidebar()`: executes the command that reveals the Activity Bar view.
- `collectUiSnapshot(label)`: writes text-friendly UI observation artifacts.
- `dumpExtensionState()`: calls the extension command through `executeWorkbench`.

## UI Observation Artifacts

Each run writes to:

```text
e2e/artifacts/<run-id>/
```

Useful files:

- `ui-reports/*.md`: best input for text-only agents reviewing UI appearance.
- `ui-snapshots/*.json`: structured DOM/style/rect snapshot.
- `html/*.html`: current frame HTML.
- `screenshots/*.png`: current rendered frame.
- `commands.jsonl`: every WebDriver command.
- `tests.jsonl`: test pass/fail/duration.
- `wdio-trace-output/trace-*.zip`: Playwright trace viewer compatible file.
- `vscode-storage/`: isolated VS Code user data for that run.

For UI review, give another agent `ui-reports/*.md` first, then screenshots/HTML if needed.

## Logging

Extension-side logs are written by `DiagnosticLogger` to:

```text
<globalStorage>/logs/extension-events.jsonl
```

During E2E this is under:

```text
e2e/artifacts/<run-id>/vscode-storage/settings/User/globalStorage/...
```

The same events are mirrored to the VS Code Output Channel named `VS Code Terminal Manager` when `vscodeTerminalManager.logToOutput` is enabled.

## Cleanup

```bash
npm run clean            # out/ and .tmp/
npm run clean:artifacts  # e2e/artifacts/
npm run clean:cache      # .wdio-vscode-cache/
npm run clean:all        # all of the above
```

Do not delete `.wdio-vscode-cache` unless you accept the next E2E run preparing VS Code again.

## Guardrails

- Keep `extension.ts` as registration glue only.
- Prefer command IDs from `src/constants.ts` in extension code.
- Keep TreeView UI deterministic enough for tests to verify visible labels and extension state.
- Do not commit `node_modules/`, `out/`, `.tmp/`, `.wdio-vscode-cache/`, or `e2e/artifacts/`.
