# AGENTS.md

## 目录作用
扩展主源码目录，包含 VS Code 激活入口、TreeView provider、终端状态管理和 tmux/zellij 后端服务。

## 可以修改
可以修改 TypeScript 源码、类型定义和内部实现结构。

## 不要修改
不要把编译产物写入本目录；编译输出属于 `out/`。

## 约定
保持 `extension.ts` 精简，业务逻辑放在 controller、manager、service 或 provider 中。代码注释使用中文。
