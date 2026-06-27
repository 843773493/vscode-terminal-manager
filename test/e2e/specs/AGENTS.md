# AGENTS.md

## 目录作用
E2E 测试用例目录。

## 可以修改
可以新增和调整 `.e2e.mjs` 用例。

## 不要修改
不要在用例里写入长流程 shell 脚本；公共逻辑放到 `support/`。

## 约定
测试创建真实 tmux/zellij 会话时必须使用唯一名称，并在 `finally` 中清理。
