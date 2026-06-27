import * as vscode from 'vscode';
import { COMMANDS, CONFIG_SECTION } from './constants';
import { MessageTreeItem } from './treeItems';
import { ZellijService } from './zellijService';
import type { ZellijSession } from './types';

export type ZellijTreeItem = ZellijSessionTreeItem | ZellijDetailTreeItem | MessageTreeItem;

export class ZellijTreeProvider implements vscode.TreeDataProvider<ZellijTreeItem>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ZellijTreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private autoRefreshTimer: NodeJS.Timeout | undefined;
  private autoRefreshEnabled = true;

  public constructor(private readonly service: ZellijService) {
    this.startAutoRefresh();
  }

  public getTreeItem(element: ZellijTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ZellijTreeItem): Promise<ZellijTreeItem[]> {
    if (element instanceof ZellijSessionTreeItem) {
      return [
        new ZellijDetailTreeItem('状态', element.session.status),
        new ZellijDetailTreeItem('创建时间', element.session.createdSummary ?? '未知')
      ];
    }

    if (element) {
      return [];
    }

    try {
      const sessions = await this.service.refresh();
      if (sessions.length === 0) {
        return [new MessageTreeItem('未发现 zellij 会话')];
      }
      return sessions.map((session) => new ZellijSessionTreeItem(session));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [new MessageTreeItem('zellij 状态读取失败', message)];
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

export class ZellijSessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: ZellijSession) {
    super(session.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'zellijSession';
    this.description = session.status;
    this.iconPath = session.status === 'running'
      ? new vscode.ThemeIcon('terminal', new vscode.ThemeColor('terminal.ansiGreen'))
      : new vscode.ThemeIcon('terminal');
    this.tooltip = new vscode.MarkdownString([
      `**Session:** ${session.name}`,
      '',
      `**Status:** ${session.status}`,
      session.createdSummary ? `**Created:** ${session.createdSummary}` : undefined,
      '',
      session.raw
    ].filter(Boolean).join('\n\n'));
    this.command = {
      command: COMMANDS.zellijAttach,
      title: '附加到 Zellij 会话',
      arguments: [this]
    };
  }
}

export class ZellijDetailTreeItem extends vscode.TreeItem {
  public constructor(label: string, description: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'zellijDetail';
    this.iconPath = new vscode.ThemeIcon('circle-small');
  }
}

function autoRefreshIntervalMs(): number {
  return Math.max(
    1000,
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('autoRefreshIntervalMs', 3000)
  );
}
