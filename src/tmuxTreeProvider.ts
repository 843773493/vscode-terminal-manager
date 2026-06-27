import * as vscode from 'vscode';
import { COMMANDS, CONFIG_SECTION } from './constants';
import { TmuxService } from './tmuxService';
import { MessageTreeItem } from './treeItems';
import type { TmuxPane, TmuxSession, TmuxWindow } from './types';

export type TmuxTreeItem = TmuxSessionTreeItem | TmuxWindowTreeItem | TmuxPaneTreeItem | MessageTreeItem;

export class TmuxTreeProvider implements vscode.TreeDataProvider<TmuxTreeItem>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TmuxTreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private autoRefreshTimer: NodeJS.Timeout | undefined;
  private autoRefreshEnabled = true;

  public constructor(private readonly service: TmuxService) {
    this.startAutoRefresh();
  }

  public getTreeItem(element: TmuxTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: TmuxTreeItem): Promise<TmuxTreeItem[]> {
    if (element instanceof TmuxSessionTreeItem) {
      return element.session.windows.map((window) => new TmuxWindowTreeItem(window, element.session.isAttached));
    }

    if (element instanceof TmuxWindowTreeItem) {
      const session = this.service.getCachedSessions().find((item) => item.name === element.window.sessionName);
      const sessionAttached = session?.isAttached ?? false;
      return element.window.panes.map((pane) => new TmuxPaneTreeItem(pane, sessionAttached, element.window.isActive));
    }

    if (element) {
      return [];
    }

    try {
      const sessions = await this.service.refresh();
      if (sessions.length === 0) {
        return [new MessageTreeItem('未发现运行中的 tmux 会话')];
      }
      return sessions.map((session) => new TmuxSessionTreeItem(session));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [new MessageTreeItem('tmux 状态读取失败', message)];
    }
  }

  public async refreshNow(): Promise<void> {
    await this.service.refresh();
    this.onDidChangeTreeDataEmitter.fire();
  }

  public refreshView(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  public toggleAutoRefresh(): boolean {
    if (this.autoRefreshEnabled) {
      this.stopAutoRefresh();
      return false;
    }

    this.startAutoRefresh();
    return true;
  }

  public isAutoRefreshEnabled(): boolean {
    return this.autoRefreshEnabled;
  }

  public dispose(): void {
    this.stopAutoRefresh();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  private startAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      return;
    }

    this.autoRefreshEnabled = true;
    this.autoRefreshTimer = setInterval(() => {
      void this.refreshNow().catch(() => this.refreshView());
    }, autoRefreshIntervalMs());
  }

  private stopAutoRefresh(): void {
    this.autoRefreshEnabled = false;
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }
}

export class TmuxSessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: TmuxSession) {
    super(session.name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'tmuxSession';
    this.iconPath = session.isAttached
      ? new vscode.ThemeIcon('server', new vscode.ThemeColor('terminal.ansiGreen'))
      : new vscode.ThemeIcon('server');
    this.description = session.isAttached ? 'attached' : 'detached';
    this.tooltip = sessionTooltip(session);
    this.command = {
      command: COMMANDS.tmuxAttach,
      title: '附加到 Tmux 会话',
      arguments: [this]
    };
  }
}

export class TmuxWindowTreeItem extends vscode.TreeItem {
  public constructor(public readonly window: TmuxWindow, sessionAttached: boolean) {
    super(`${window.index}:${window.name}`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'tmuxWindow';
    this.iconPath = window.isActive && sessionAttached
      ? new vscode.ThemeIcon('window', new vscode.ThemeColor('terminal.ansiGreen'))
      : new vscode.ThemeIcon('window');
    this.description = window.isActive ? 'active' : undefined;
    this.tooltip = windowTooltip(window);
    this.command = {
      command: COMMANDS.tmuxAttach,
      title: '切换到 Tmux 窗口',
      arguments: [this]
    };
  }
}

export class TmuxPaneTreeItem extends vscode.TreeItem {
  public constructor(public readonly pane: TmuxPane, sessionAttached: boolean, windowActive: boolean) {
    super(`${pane.index}: ${pane.command}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'tmuxPane';
    const iconName = commandIconName(pane.command);
    this.iconPath = pane.isActive && windowActive && sessionAttached
      ? new vscode.ThemeIcon(iconName, new vscode.ThemeColor('terminal.ansiGreen'))
      : new vscode.ThemeIcon(iconName);
    this.description = pane.currentPath !== '~' ? pane.currentPath : undefined;
    this.tooltip = paneTooltip(pane);
    this.command = {
      command: COMMANDS.tmuxAttach,
      title: '切换到 Tmux 面板',
      arguments: [this]
    };
  }
}

function autoRefreshIntervalMs(): number {
  return Math.max(
    1000,
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('autoRefreshIntervalMs', 3000)
  );
}

function sessionTooltip(session: TmuxSession): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**Session:** ${session.name}\n\n`);
  tooltip.appendMarkdown(`**Status:** ${session.isAttached ? 'Attached' : 'Detached'}\n\n`);
  if (session.created) {
    tooltip.appendMarkdown(`**Created:** ${formatUnixTime(session.created)}\n\n`);
  }
  if (session.lastActivity) {
    tooltip.appendMarkdown(`**Last Activity:** ${formatUnixTime(session.lastActivity)}\n\n`);
  }
  tooltip.appendMarkdown(`**Windows:** ${session.windows.length}`);
  return tooltip;
}

function windowTooltip(window: TmuxWindow): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**Window:** ${window.index}:${window.name}\n\n`);
  tooltip.appendMarkdown(`**Session:** ${window.sessionName}\n\n`);
  tooltip.appendMarkdown(`**Status:** ${window.isActive ? 'Active' : 'Inactive'}\n\n`);
  tooltip.appendMarkdown(`**Panes:** ${window.panes.length}`);
  return tooltip;
}

function paneTooltip(pane: TmuxPane): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**Pane:** ${pane.index}\n\n`);
  tooltip.appendMarkdown(`**Command:** ${pane.command}\n\n`);
  tooltip.appendMarkdown(`**Path:** ${pane.currentPath}\n\n`);
  tooltip.appendMarkdown(`**Status:** ${pane.isActive ? 'Active' : 'Inactive'}\n\n`);
  if (pane.pid > 0) {
    tooltip.appendMarkdown(`**PID:** ${pane.pid}\n\n`);
  }
  tooltip.appendMarkdown(`**Target:** ${pane.sessionName}:${pane.windowIndex}.${pane.index}`);
  return tooltip;
}

function formatUnixTime(value: string): string {
  const timestamp = Number.parseInt(value, 10);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return value;
  }
  return new Date(timestamp * 1000).toLocaleString();
}

function commandIconName(command: string): string {
  const lowerCommand = command.toLowerCase();
  if (lowerCommand.includes('vim') || lowerCommand.includes('nvim')) {
    return 'edit';
  }
  if (lowerCommand.includes('ssh')) {
    return 'remote';
  }
  if (lowerCommand.includes('bash') || lowerCommand.includes('zsh') || lowerCommand.includes('sh')) {
    return 'terminal-bash';
  }
  if (lowerCommand.includes('python') || lowerCommand.includes('py')) {
    return 'symbol-method';
  }
  if (lowerCommand.includes('node') || lowerCommand.includes('npm')) {
    return 'nodejs';
  }
  if (lowerCommand.includes('git')) {
    return 'git-branch';
  }
  if (lowerCommand.includes('docker')) {
    return 'server-environment';
  }
  return 'terminal';
}
