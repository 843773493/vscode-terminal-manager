import * as vscode from 'vscode';
import { COMMANDS, TMUX_VIEW_ID, WORKBENCH_VIEW_COMMAND, WORKSPACE_VIEW_ID, ZELLIJ_VIEW_ID } from './constants';
import type { DiagnosticLogger } from './diagnosticLogger';
import { errorMessage } from './processRunner';
import { buildTmuxAttachCommand, buildZellijAttachCommand } from './shell';
import { TmuxService } from './tmuxService';
import {
  TmuxPaneTreeItem,
  TmuxSessionTreeItem,
  TmuxTreeProvider,
  TmuxWindowTreeItem
} from './tmuxTreeProvider';
import type { CreateTerminalRequest, DiagnosticEvent, MultiplexerKind, TerminalManagerState } from './types';
import { WorkspaceTerminalManager, WorkspaceTerminalTreeItem } from './workspaceTerminalManager';
import { ZellijService } from './zellijService';
import { ZellijSessionTreeItem, ZellijTreeProvider } from './zellijTreeProvider';

type SessionCommandArg = string | {
  sessionName?: string;
  newName?: string;
  reveal?: boolean;
  confirm?: boolean;
  attachMode?: CreateTerminalRequest['attachMode'];
  closeTerminals?: boolean;
};

export class TerminalManagerController implements vscode.Disposable {
  private readonly tmuxService = new TmuxService();
  private readonly zellijService = new ZellijService();
  private readonly tmuxProvider = new TmuxTreeProvider(this.tmuxService);
  private readonly zellijProvider = new ZellijTreeProvider(this.zellijService);
  private readonly workspaceManager: WorkspaceTerminalManager;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly events: DiagnosticEvent[] = [];
  private status = 'Ready';

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: DiagnosticLogger
  ) {
    this.workspaceManager = new WorkspaceTerminalManager(context, (name, data) => this.record(name, data));
    this.disposables.push(
      this.workspaceManager,
      this.tmuxProvider,
      this.zellijProvider,
      vscode.window.createTreeView(WORKSPACE_VIEW_ID, {
        treeDataProvider: this.workspaceManager,
        showCollapseAll: true
      }),
      vscode.window.createTreeView(ZELLIJ_VIEW_ID, {
        treeDataProvider: this.zellijProvider,
        showCollapseAll: true
      }),
      vscode.window.createTreeView(TMUX_VIEW_ID, {
        treeDataProvider: this.tmuxProvider,
        showCollapseAll: true
      }),
      this.workspaceManager.onDidObserveMultiplexerCommand((observation) => {
        this.refreshAfterTerminalCommand(observation.kind);
      })
    );
    this.registerCommands();
    this.scheduleStartupRestore();
  }

  public getState(): TerminalManagerState {
    return {
      status: this.status,
      logFile: this.logger.path,
      events: [...this.events],
      workspace: this.workspaceManager.state(),
      zellij: this.zellijService.state(this.zellijProvider.isAutoRefreshEnabled()),
      tmux: this.tmuxService.state(this.tmuxProvider.isAutoRefreshEnabled())
    };
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand(COMMANDS.openSidebar, () => this.openSidebar()),
      vscode.commands.registerCommand(COMMANDS.refreshAll, () => this.refreshAll()),
      vscode.commands.registerCommand(COMMANDS.dumpState, () => this.dumpState()),
      vscode.commands.registerCommand(COMMANDS.emitTestLog, (label?: string) => this.emitTestLog(label)),
      vscode.commands.registerCommand(COMMANDS.workspaceCreate, (request?: CreateTerminalRequest) => this.workspaceCreate(request)),
      vscode.commands.registerCommand(COMMANDS.workspaceRefresh, () => this.workspaceRefresh()),
      vscode.commands.registerCommand(COMMANDS.workspaceToggleAutoSave, () => this.workspaceToggleAutoSave()),
      vscode.commands.registerCommand(COMMANDS.workspaceSave, () => this.workspaceSave()),
      vscode.commands.registerCommand(COMMANDS.workspaceShow, (item?: WorkspaceTerminalTreeItem) => this.workspaceManager.showTerminal(item)),
      vscode.commands.registerCommand(COMMANDS.workspaceRestoreRegistered, () => this.workspaceRestoreRegistered(false)),
      vscode.commands.registerCommand(COMMANDS.workspaceKill, (item?: WorkspaceTerminalTreeItem) => this.workspaceKill(item)),
      vscode.commands.registerCommand(COMMANDS.zellijNew, (arg?: SessionCommandArg) => this.zellijNew(arg)),
      vscode.commands.registerCommand(COMMANDS.zellijAttach, (arg?: ZellijSessionTreeItem | SessionCommandArg) => this.zellijAttach(arg)),
      vscode.commands.registerCommand(COMMANDS.zellijRename, (arg?: ZellijSessionTreeItem | SessionCommandArg) => this.zellijRename(arg)),
      vscode.commands.registerCommand(COMMANDS.zellijKill, (arg?: ZellijSessionTreeItem | SessionCommandArg) => this.zellijKill(arg)),
      vscode.commands.registerCommand(COMMANDS.zellijDelete, (arg?: ZellijSessionTreeItem | SessionCommandArg) => this.zellijDelete(arg)),
      vscode.commands.registerCommand(COMMANDS.zellijRefresh, () => this.zellijRefresh()),
      vscode.commands.registerCommand(COMMANDS.zellijToggleAutoRefresh, () => this.zellijToggleAutoRefresh()),
      vscode.commands.registerCommand(COMMANDS.tmuxNew, (arg?: SessionCommandArg) => this.tmuxNew(arg)),
      vscode.commands.registerCommand(COMMANDS.tmuxAttach, (item?: TmuxSessionTreeItem | TmuxWindowTreeItem | TmuxPaneTreeItem | SessionCommandArg) => this.tmuxAttach(item)),
      vscode.commands.registerCommand(COMMANDS.tmuxRename, (item?: TmuxSessionTreeItem | SessionCommandArg) => this.tmuxRename(item)),
      vscode.commands.registerCommand(COMMANDS.tmuxRenameWindow, (item?: TmuxWindowTreeItem) => this.tmuxRenameWindow(item)),
      vscode.commands.registerCommand(COMMANDS.tmuxNewWindow, (item?: TmuxSessionTreeItem) => this.tmuxNewWindow(item)),
      vscode.commands.registerCommand(COMMANDS.tmuxKillSession, (item?: TmuxSessionTreeItem | SessionCommandArg) => this.tmuxKillSession(item)),
      vscode.commands.registerCommand(COMMANDS.tmuxKillWindow, (item?: TmuxWindowTreeItem) => this.tmuxKillWindow(item)),
      vscode.commands.registerCommand(COMMANDS.tmuxKillPane, (item?: TmuxPaneTreeItem) => this.tmuxKillPane(item)),
      vscode.commands.registerCommand(COMMANDS.tmuxSplitPaneRight, (item?: TmuxPaneTreeItem) => this.tmuxSplitPane(item, 'right')),
      vscode.commands.registerCommand(COMMANDS.tmuxSplitPaneDown, (item?: TmuxPaneTreeItem) => this.tmuxSplitPane(item, 'down')),
      vscode.commands.registerCommand(COMMANDS.tmuxRefresh, () => this.tmuxRefresh()),
      vscode.commands.registerCommand(COMMANDS.tmuxToggleAutoRefresh, () => this.tmuxToggleAutoRefresh())
    );
  }

  private async openSidebar(): Promise<TerminalManagerState> {
    await vscode.commands.executeCommand(WORKBENCH_VIEW_COMMAND);
    this.record('command.openSidebar');
    return this.getState();
  }

  private async refreshAll(): Promise<TerminalManagerState> {
    await this.runCommand('command.refreshAll', async () => {
      await Promise.allSettled([
        this.workspaceManager.saveNow('refreshAll'),
        this.zellijProvider.refreshNow(),
        this.tmuxProvider.refreshNow()
      ]);
      this.status = 'Refreshed all terminal state';
    });
    return this.getState();
  }

  private async dumpState(): Promise<TerminalManagerState> {
    await Promise.allSettled([
      this.workspaceManager.saveNow('dumpState'),
      this.zellijService.refresh(),
      this.tmuxService.refresh()
    ]);
    this.zellijProvider.refreshView();
    this.tmuxProvider.refreshView();
    const state = this.getState();
    this.record('command.dumpState', {
      workspaceTerminals: state.workspace.registeredTerminals.length,
      zellijSessions: state.zellij.sessions.length,
      tmuxSessions: state.tmux.sessions.length
    });
    return state;
  }

  private emitTestLog(label = 'manual'): TerminalManagerState {
    this.status = `Log emitted: ${label}`;
    this.record('test.log', { label });
    return this.getState();
  }

  private async workspaceCreate(request?: CreateTerminalRequest): Promise<TerminalManagerState> {
    await this.runCommand('command.workspaceCreate', async () => {
      await this.workspaceManager.createTerminal(request);
      await this.refreshBackendsForKind(request?.kind);
      this.status = 'Registered workspace terminal created';
    });
    return this.getState();
  }

  private async workspaceRefresh(): Promise<TerminalManagerState> {
    await this.workspaceManager.saveNow('workspaceRefresh');
    this.status = 'Registered workspace terminals refreshed';
    this.record('command.workspaceRefresh');
    return this.getState();
  }

  private workspaceToggleAutoSave(): TerminalManagerState {
    const enabled = this.workspaceManager.toggleAutoSave();
    this.status = enabled ? '已开启自动记住会话终端' : '已关闭自动记住会话终端';
    this.record('command.workspaceToggleAutoSave', { enabled });
    vscode.window.showInformationMessage(this.status);
    return this.getState();
  }

  private async workspaceSave(): Promise<TerminalManagerState> {
    await this.workspaceManager.saveNow('workspaceSave');
    this.status = '已记住当前会话终端';
    this.record('command.workspaceSave');
    vscode.window.showInformationMessage('已记住当前会话终端。');
    return this.getState();
  }

  private async workspaceRestoreRegistered(reveal: boolean): Promise<TerminalManagerState> {
    const restored = await this.workspaceManager.restoreRegisteredTerminals(reveal);
    this.status = `已附加 ${restored} 个已记住的会话终端`;
    this.record('command.workspaceRestoreRegistered', { restored });
    return this.getState();
  }

  private async workspaceKill(item?: WorkspaceTerminalTreeItem): Promise<TerminalManagerState> {
    await this.workspaceManager.killTerminal(item);
    this.status = 'Workspace terminal closed';
    return this.getState();
  }

  private async zellijNew(arg?: SessionCommandArg): Promise<TerminalManagerState> {
    await this.runCommand('command.zellijNew', async () => {
      const sessionName = await this.resolveSessionName('zellij', arg);
      if (!sessionName) {
        return;
      }
      await this.zellijService.createSession(sessionName);
      await this.workspaceManager.createTerminal({
        kind: 'zellij',
        sessionName,
        reveal: revealFromArg(arg),
        attachMode: attachModeFromArg(arg) ?? 'attach'
      });
      await this.zellijProvider.refreshNow();
      this.status = `Created zellij session ${sessionName}`;
    });
    return this.getState();
  }

  private async zellijAttach(arg?: ZellijSessionTreeItem | SessionCommandArg): Promise<TerminalManagerState> {
    await this.runCommand('command.zellijAttach', async () => {
      const sessionName = await this.resolveZellijSessionFromArg(arg);
      if (!sessionName) {
        return;
      }
      await this.workspaceManager.createTerminal({
        kind: 'zellij',
        sessionName,
        reveal: revealFromArg(arg),
        attachMode: 'attach'
      });
      this.status = `Attached zellij session ${sessionName}`;
    });
    return this.getState();
  }

  private async zellijRename(arg?: ZellijSessionTreeItem | SessionCommandArg): Promise<TerminalManagerState> {
    await this.runCommand('command.zellijRename', async () => {
      const sessionName = await this.resolveZellijSessionFromArg(arg);
      if (!sessionName) {
        return;
      }
      const newName = await this.resolveRenameSessionName('zellij', sessionName, arg);
      if (!newName || newName === sessionName) {
        return;
      }

      await this.zellijService.renameSession(sessionName, newName);
      await this.workspaceManager.renameSession('zellij', sessionName, newName, 'zellij.rename');
      await this.zellijProvider.refreshNow();
      this.status = `Renamed zellij session ${sessionName} to ${newName}`;
    });
    return this.getState();
  }

  private async zellijKill(arg?: ZellijSessionTreeItem | SessionCommandArg): Promise<TerminalManagerState> {
    await this.runCommand('command.zellijKill', async () => {
      const sessionName = await this.resolveZellijSessionFromArg(arg);
      if (!sessionName || !(await this.confirmDestructive('结束', 'zellij', sessionName, arg))) {
        return;
      }
      if (closeTerminalsFromArg(arg)) {
        await this.workspaceManager.closeSessionTerminals('zellij', sessionName, 'zellij.kill');
      }
      await this.zellijService.killSession(sessionName);
      await this.workspaceManager.unregisterSession('zellij', sessionName, 'zellij.kill');
      await this.zellijProvider.refreshNow();
      this.status = `Killed zellij session ${sessionName}`;
    });
    return this.getState();
  }

  private async zellijDelete(arg?: ZellijSessionTreeItem | SessionCommandArg): Promise<TerminalManagerState> {
    await this.runCommand('command.zellijDelete', async () => {
      const sessionName = await this.resolveZellijSessionFromArg(arg);
      if (!sessionName || !(await this.confirmDestructive('删除', 'zellij', sessionName, arg))) {
        return;
      }
      if (closeTerminalsFromArg(arg)) {
        await this.workspaceManager.closeSessionTerminals('zellij', sessionName, 'zellij.delete');
      }
      await this.zellijService.deleteSession(sessionName);
      await this.workspaceManager.unregisterSession('zellij', sessionName, 'zellij.delete');
      await this.zellijProvider.refreshNow();
      this.status = `Deleted zellij session ${sessionName}`;
    });
    return this.getState();
  }

  private async zellijRefresh(): Promise<TerminalManagerState> {
    await this.runCommand('command.zellijRefresh', async () => {
      await this.zellijProvider.refreshNow();
      this.status = 'Zellij sessions refreshed';
    });
    return this.getState();
  }

  private zellijToggleAutoRefresh(): TerminalManagerState {
    const enabled = this.zellijProvider.toggleAutoRefresh();
    this.status = enabled ? 'Zellij auto-refresh enabled' : 'Zellij auto-refresh disabled';
    this.record('command.zellijToggleAutoRefresh', { enabled });
    vscode.window.showInformationMessage(this.status);
    return this.getState();
  }

  private async tmuxNew(arg?: SessionCommandArg): Promise<TerminalManagerState> {
    await this.runCommand('command.tmuxNew', async () => {
      const sessionName = await this.resolveSessionName('tmux', arg);
      if (!sessionName) {
        return;
      }
      await this.tmuxService.createSession(sessionName);
      await this.workspaceManager.createTerminal({
        kind: 'tmux',
        sessionName,
        reveal: revealFromArg(arg),
        attachMode: attachModeFromArg(arg) ?? 'attach'
      });
      await this.tmuxProvider.refreshNow();
      this.status = `Created tmux session ${sessionName}`;
    });
    return this.getState();
  }

  private async tmuxAttach(item?: TmuxSessionTreeItem | TmuxWindowTreeItem | TmuxPaneTreeItem | SessionCommandArg): Promise<TerminalManagerState> {
    await this.runCommand('command.tmuxAttach', async () => {
      const target = await this.resolveTmuxTarget(item);
      if (!target) {
        return;
      }

      if (target.windowIndex) {
        await this.tmuxService.selectWindow(target.sessionName, target.windowIndex);
      }
      if (target.windowIndex && target.paneIndex) {
        await this.tmuxService.selectPane(target.sessionName, target.windowIndex, target.paneIndex);
      }

      await this.workspaceManager.createTerminal({
        kind: 'tmux',
        sessionName: target.sessionName,
        reveal: revealFromArg(item),
        attachMode: 'attach'
      });
      this.status = `Attached tmux session ${target.sessionName}`;
    });
    return this.getState();
  }

  private async tmuxRename(item?: TmuxSessionTreeItem | SessionCommandArg): Promise<TerminalManagerState> {
    await this.runCommand('command.tmuxRename', async () => {
      const sessionName = item instanceof TmuxSessionTreeItem
        ? item.session.name
        : await this.resolveSessionName('tmux', item, false) ?? await this.pickTmuxSession();
      if (!sessionName) {
        return;
      }
      const newName = await this.resolveRenameSessionName('tmux', sessionName, item);
      if (!newName || newName === sessionName) {
        return;
      }
      await this.tmuxService.renameSession(sessionName, newName);
      await this.workspaceManager.renameSession('tmux', sessionName, newName, 'tmux.rename');
      await this.tmuxProvider.refreshNow();
      this.status = `Renamed tmux session ${sessionName} to ${newName}`;
    });
    return this.getState();
  }

  private async tmuxRenameWindow(item?: TmuxWindowTreeItem): Promise<TerminalManagerState> {
    await this.runCommand('command.tmuxRenameWindow', async () => {
      if (!item) {
        vscode.window.showWarningMessage('请选择要重命名的 tmux 窗口。');
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: `重命名 tmux 窗口 ${item.window.index}:${item.window.name}`,
        value: item.window.name,
        validateInput: (value) => value.trim() ? undefined : '窗口名称不能为空。'
      });
      if (!newName || newName === item.window.name) {
        return;
      }
      await this.tmuxService.renameWindow(item.window.sessionName, item.window.index, newName);
      await this.tmuxProvider.refreshNow();
      this.status = `Renamed tmux window ${item.window.index}`;
    });
    return this.getState();
  }

  private async tmuxNewWindow(item?: TmuxSessionTreeItem): Promise<TerminalManagerState> {
    await this.runCommand('command.tmuxNewWindow', async () => {
      const sessionName = item?.session.name ?? await this.pickTmuxSession();
      if (!sessionName) {
        return;
      }
      const windowName = await vscode.window.showInputBox({
        prompt: `输入 ${sessionName} 的新窗口名称（可选）`
      });
      await this.tmuxService.newWindow(sessionName, windowName?.trim() || undefined);
      await this.tmuxProvider.refreshNow();
      this.status = `Created tmux window in ${sessionName}`;
    });
    return this.getState();
  }

  private async tmuxKillSession(item?: TmuxSessionTreeItem | SessionCommandArg): Promise<TerminalManagerState> {
    await this.runCommand('command.tmuxKillSession', async () => {
      const sessionName = item instanceof TmuxSessionTreeItem
        ? item.session.name
        : await this.resolveSessionName('tmux', item, false);
      if (!sessionName || !(await this.confirmDestructive('结束', 'tmux', sessionName, item))) {
        return;
      }
      if (closeTerminalsFromArg(item)) {
        await this.workspaceManager.closeSessionTerminals('tmux', sessionName, 'tmux.killSession');
      }
      await this.tmuxService.killSession(sessionName);
      await this.workspaceManager.unregisterSession('tmux', sessionName, 'tmux.killSession');
      await this.tmuxProvider.refreshNow();
      this.status = `Killed tmux session ${sessionName}`;
    });
    return this.getState();
  }

  private async tmuxKillWindow(item?: TmuxWindowTreeItem): Promise<TerminalManagerState> {
    await this.runCommand('command.tmuxKillWindow', async () => {
      if (!item) {
        vscode.window.showWarningMessage('请选择要结束的 tmux 窗口。');
        return;
      }
      if (!(await this.confirmDestructive('结束', 'tmux 窗口', `${item.window.sessionName}:${item.window.index}`))) {
        return;
      }
      await this.tmuxService.killWindow(item.window.sessionName, item.window.index);
      await this.tmuxProvider.refreshNow();
      this.status = `Killed tmux window ${item.window.index}`;
    });
    return this.getState();
  }

  private async tmuxKillPane(item?: TmuxPaneTreeItem): Promise<TerminalManagerState> {
    await this.runCommand('command.tmuxKillPane', async () => {
      if (!item) {
        vscode.window.showWarningMessage('请选择要结束的 tmux 面板。');
        return;
      }
      const target = `${item.pane.sessionName}:${item.pane.windowIndex}.${item.pane.index}`;
      if (!(await this.confirmDestructive('结束', 'tmux 面板', target))) {
        return;
      }
      await this.tmuxService.killPane(item.pane.sessionName, item.pane.windowIndex, item.pane.index);
      await this.tmuxProvider.refreshNow();
      this.status = `Killed tmux pane ${target}`;
    });
    return this.getState();
  }

  private async tmuxSplitPane(item: TmuxPaneTreeItem | undefined, direction: 'right' | 'down'): Promise<TerminalManagerState> {
    await this.runCommand(`command.tmuxSplitPane.${direction}`, async () => {
      if (!item) {
        vscode.window.showWarningMessage('请选择要拆分的 tmux 面板。');
        return;
      }
      await this.tmuxService.splitPane(item.pane.sessionName, item.pane.windowIndex, item.pane.index, direction);
      await this.tmuxProvider.refreshNow();
      this.status = `Split tmux pane ${direction}`;
    });
    return this.getState();
  }

  private async tmuxRefresh(): Promise<TerminalManagerState> {
    await this.runCommand('command.tmuxRefresh', async () => {
      await this.tmuxProvider.refreshNow();
      this.status = 'Tmux sessions refreshed';
    });
    return this.getState();
  }

  private tmuxToggleAutoRefresh(): TerminalManagerState {
    const enabled = this.tmuxProvider.toggleAutoRefresh();
    this.status = enabled ? 'Tmux auto-refresh enabled' : 'Tmux auto-refresh disabled';
    this.record('command.tmuxToggleAutoRefresh', { enabled });
    vscode.window.showInformationMessage(this.status);
    return this.getState();
  }

  private async runCommand(name: string, operation: () => Promise<void>): Promise<void> {
    this.record(name);
    try {
      await operation();
    } catch (error) {
      const message = errorMessage(error);
      this.status = `${name} failed: ${message}`;
      this.record(`${name}.failed`, { message });
      vscode.window.showErrorMessage(message);
      throw error;
    }
  }

  private record(name: string, data?: unknown): void {
    const event = { at: new Date().toISOString(), name, data };
    this.events.push(event);
    if (this.events.length > 100) {
      this.events.shift();
    }
    this.logger.write(name, data);
  }

  private scheduleStartupRestore(): void {
    if (this.context.extensionMode === vscode.ExtensionMode.Test) {
      this.record('workspace.startupRestore.skipped', {
        reason: 'extensionTestHost',
        extensionMode: this.context.extensionMode
      });
      return;
    }

    const timer = setTimeout(() => {
      void this.workspaceManager.restoreOnStartupIfEnabled()
        .then((restored) => {
          this.record('workspace.startupRestore.finished', { restored });
          return this.refreshAll();
        })
        .catch((error: unknown) => {
          this.record('workspace.startupRestore.failed', { message: errorMessage(error) });
        });
    }, 1500);
    this.disposables.push(new vscode.Disposable(() => clearTimeout(timer)));
  }

  private refreshAfterTerminalCommand(kind: MultiplexerKind): void {
    const timer = setTimeout(() => {
      void this.refreshBackendsForKind(kind).catch((error: unknown) => {
        this.record('terminalCommand.refresh.failed', {
          kind,
          message: errorMessage(error)
        });
      });
    }, 700);
    this.disposables.push(new vscode.Disposable(() => clearTimeout(timer)));
  }

  private async refreshBackendsForKind(kind: MultiplexerKind | undefined): Promise<void> {
    if (kind === 'zellij') {
      await this.zellijProvider.refreshNow();
      return;
    }
    if (kind === 'tmux') {
      await this.tmuxProvider.refreshNow();
    }
  }

  private async resolveSessionName(kind: MultiplexerKind, arg?: SessionCommandArg, promptIfMissing = true): Promise<string | undefined> {
    if (typeof arg === 'string') {
      return arg;
    }
    if (arg?.sessionName) {
      return arg.sessionName;
    }
    if (!promptIfMissing) {
      return undefined;
    }
    const workspaceName = vscode.workspace.name ?? 'workspace';
    return vscode.window.showInputBox({
      prompt: `输入 ${kind} 会话名称`,
      value: `${workspaceName}-${kind}`,
      validateInput: (value) => value.trim() ? undefined : '会话名称不能为空。'
    });
  }

  private async resolveRenameSessionName(
    kind: MultiplexerKind,
    sessionName: string,
    arg?: ZellijSessionTreeItem | TmuxSessionTreeItem | SessionCommandArg
  ): Promise<string | undefined> {
    const directName = newNameFromArg(arg);
    if (directName !== undefined) {
      const trimmed = directName.trim();
      if (!trimmed) {
        vscode.window.showWarningMessage('新会话名称不能为空。');
        return undefined;
      }
      return trimmed;
    }

    const picked = await vscode.window.showInputBox({
      prompt: `重命名 ${kind} 会话 ${sessionName}`,
      value: sessionName,
      validateInput: (value) => value.trim() ? undefined : '会话名称不能为空。'
    });
    return picked?.trim();
  }

  private async resolveZellijSessionFromArg(arg?: ZellijSessionTreeItem | SessionCommandArg): Promise<string | undefined> {
    if (arg instanceof ZellijSessionTreeItem) {
      return arg.session.name;
    }
    const directName = await this.resolveSessionName('zellij', arg, false);
    if (directName) {
      return directName;
    }
    return this.pickZellijSession();
  }

  private async resolveTmuxTarget(
    item?: TmuxSessionTreeItem | TmuxWindowTreeItem | TmuxPaneTreeItem | SessionCommandArg
  ): Promise<{ sessionName: string; windowIndex?: string; paneIndex?: string } | undefined> {
    if (item instanceof TmuxSessionTreeItem) {
      return { sessionName: item.session.name };
    }
    if (item instanceof TmuxWindowTreeItem) {
      return { sessionName: item.window.sessionName, windowIndex: item.window.index };
    }
    if (item instanceof TmuxPaneTreeItem) {
      return {
        sessionName: item.pane.sessionName,
        windowIndex: item.pane.windowIndex,
        paneIndex: item.pane.index
      };
    }

    const sessionName = await this.resolveSessionName('tmux', item, false) ?? await this.pickTmuxSession();
    return sessionName ? { sessionName } : undefined;
  }

  private async pickZellijSession(): Promise<string | undefined> {
    const sessions = await this.zellijService.refresh();
    const picked = await vscode.window.showQuickPick(sessions.map((session) => session.name), {
      placeHolder: '选择 Zellij 会话'
    });
    return picked;
  }

  private async pickTmuxSession(): Promise<string | undefined> {
    const sessions = await this.tmuxService.refresh();
    const picked = await vscode.window.showQuickPick(sessions.map((session) => session.name), {
      placeHolder: '选择 Tmux 会话'
    });
    return picked;
  }

  private async confirmDestructive(
    action: string,
    targetKind: string,
    targetName: string,
    arg?: SessionCommandArg | ZellijSessionTreeItem | TmuxSessionTreeItem
  ): Promise<boolean> {
    if (typeof arg === 'object' && !(arg instanceof ZellijSessionTreeItem) && !(arg instanceof TmuxSessionTreeItem) && arg.confirm === false) {
      return true;
    }

    const picked = await vscode.window.showWarningMessage(
      `确认${action}${targetKind} "${targetName}"？`,
      { modal: true },
      action
    );
    return picked === action;
  }
}

function revealFromArg(arg: unknown): boolean {
  if (typeof arg === 'object' && arg !== null && 'reveal' in arg && typeof arg.reveal === 'boolean') {
    return arg.reveal;
  }
  return true;
}

function attachModeFromArg(arg: unknown): CreateTerminalRequest['attachMode'] | undefined {
  if (typeof arg === 'object' && arg !== null && 'attachMode' in arg) {
    const mode = arg.attachMode;
    if (mode === 'attach' || mode === 'createOrAttach' || mode === 'none') {
      return mode;
    }
  }
  return undefined;
}

function closeTerminalsFromArg(arg: unknown): boolean {
  if (typeof arg === 'object' && arg !== null && 'closeTerminals' in arg && typeof arg.closeTerminals === 'boolean') {
    return arg.closeTerminals;
  }
  return true;
}

function newNameFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'object' && arg !== null && 'newName' in arg && typeof arg.newName === 'string') {
    return arg.newName;
  }
  return undefined;
}

export function attachCommandPreview(kind: MultiplexerKind, sessionName: string): string {
  return kind === 'zellij'
    ? buildZellijAttachCommand(sessionName)
    : buildTmuxAttachCommand(sessionName);
}
