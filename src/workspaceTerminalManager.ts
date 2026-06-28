import * as vscode from 'vscode';
import {
  CONFIG_SECTION,
  COMMANDS,
  WORKSPACE_TERMINAL_STATE_KEY
} from './constants';
import {
  buildTmuxAttachCommand,
  buildTmuxExistingSessionAttachCommand,
  buildZellijAttachCommand,
  buildZellijExistingSessionAttachCommand,
  inferMultiplexerCommand,
  kindFromTerminalName,
  normalizeLocationKind,
  terminalShellFlavor
} from './shell';
import { MessageTreeItem } from './treeItems';
import type {
  CreateTerminalRequest,
  MultiplexerCommandObservation,
  MultiplexerKind,
  SavedTerminalLocation,
  TerminalLaunchSource,
  WorkspaceState,
  WorkspaceTerminalKind,
  WorkspaceTerminalSnapshot
} from './types';

type WorkspaceTreeItem = WorkspaceTerminalTreeItem | MessageTreeItem;
type EventRecorder = (name: string, data?: unknown) => void;

interface ActiveTerminalRecord {
  terminal: vscode.Terminal;
  snapshot: WorkspaceTerminalSnapshot;
}

export class WorkspaceTerminalManager implements vscode.TreeDataProvider<WorkspaceTreeItem>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<WorkspaceTreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly onDidObserveMultiplexerCommandEmitter = new vscode.EventEmitter<MultiplexerCommandObservation>();
  public readonly onDidObserveMultiplexerCommand = this.onDidObserveMultiplexerCommandEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly activeRecords = new Map<vscode.Terminal, ActiveTerminalRecord>();
  private readonly ignoredTerminals = new WeakSet<vscode.Terminal>();
  private registeredSnapshots: WorkspaceTerminalSnapshot[] = [];
  private autoSaveTimer: NodeJS.Timeout | undefined;
  private autoSaveEnabled = true;
  private restoredThisActivation = false;
  private nextId = 1;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly record: EventRecorder
  ) {
    this.registeredSnapshots = this.readRegisteredSnapshots();
    this.trackExistingTerminals();
    this.registerTerminalListeners();
    this.startAutoSave();
  }

  public getTreeItem(element: WorkspaceTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: WorkspaceTreeItem): WorkspaceTreeItem[] {
    const active = this.activeSnapshots();

    if (element) {
      return [];
    }

    if (active.length === 0) {
      return [new MessageTreeItem(
        this.registeredSnapshots.length > 0
          ? '已记住的 Tmux/Zellij 会话尚未附加'
          : '尚未记住 Tmux/Zellij 会话'
      )];
    }

    return active.map((snapshot) => new WorkspaceTerminalTreeItem(snapshot));
  }

  public refreshView(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  public state(): WorkspaceState {
    return {
      autoSaveEnabled: this.autoSaveEnabled,
      autoRestoreEnabled: this.autoRestoreEnabled(),
      restoredThisActivation: this.restoredThisActivation,
      activeTerminals: this.activeSnapshots(),
      registeredTerminals: this.allRegisteredSnapshots()
    };
  }

  public async createTerminal(request: CreateTerminalRequest = {}): Promise<WorkspaceTerminalSnapshot | undefined> {
    const kind = request.kind ?? await this.pickTerminalKind();
    if (!kind) {
      return undefined;
    }

    const sessionName = request.sessionName ?? await this.inputSessionName(kind);
    if (!sessionName) {
      return undefined;
    }

    const cwd = request.cwd ?? defaultWorkspaceCwd();
    const shellPath = request.shellPath ?? defaultShellPath(kind);
    const shellArgs = request.shellArgs;
    const terminal = vscode.window.createTerminal({
      name: terminalName(kind, sessionName),
      cwd,
      shellPath,
      shellArgs,
      location: locationForCreate(request.location),
      isTransient: true
    });

    const snapshot = this.trackTerminal(terminal, 'extension', {
      kind,
      sessionName,
      cwd,
      shellPath,
      shellArgs,
      location: normalizeLocationKind(request.location)
    });
    if (!snapshot) {
      return undefined;
    }

    const attachCommand = attachCommandFor(kind, sessionName, request.attachMode, shellPath);
    if (attachCommand) {
      terminal.sendText(attachCommand);
    }

    if (request.reveal ?? true) {
      terminal.show(false);
    }

    await this.updatePid(terminal);
    await this.saveNow('workspace.createTerminal');
    this.record('workspace.terminal.created', { kind, sessionName, terminalName: terminal.name });
    return snapshot;
  }

  public showTerminal(item?: WorkspaceTerminalTreeItem): void {
    const terminal = item ? this.findTerminalBySnapshotId(item.snapshot.id) : vscode.window.activeTerminal;
    if (!terminal) {
      vscode.window.showWarningMessage('没有可显示的终端。');
      return;
    }

    terminal.show(false);
    this.record('workspace.terminal.show', { terminalName: terminal.name });
  }

  public async killTerminal(item?: WorkspaceTerminalTreeItem): Promise<void> {
    if (!item) {
      vscode.window.showWarningMessage('请选择要关闭的工作区终端。');
      return;
    }

    const terminal = this.findTerminalBySnapshotId(item.snapshot.id);
    if (terminal) {
      terminal.dispose();
    }

    await this.saveNow('workspace.killTerminal');
    this.refreshView();
    this.record('workspace.terminal.kill', { id: item.snapshot.id, terminalName: item.snapshot.name });
  }

  public async restoreRegisteredTerminals(reveal = false): Promise<number> {
    let restored = 0;

    for (const snapshot of this.restoreCandidates()) {
      if (await this.restoreSnapshot(snapshot, reveal)) {
        restored += 1;
      }
    }

    await this.saveNow('workspace.restoreRegistered');
    this.record('workspace.restoreRegistered', { restored });
    return restored;
  }

  public async restoreOnStartupIfEnabled(): Promise<number> {
    if (this.restoredThisActivation || !this.autoRestoreEnabled()) {
      return 0;
    }

    this.restoredThisActivation = true;
    return this.restoreRegisteredTerminals(false);
  }

  public async unregisterSession(kind: MultiplexerKind, sessionName: string, reason = 'manual'): Promise<number> {
    let unregistered = 0;
    for (const [terminal, record] of this.activeRecords) {
      if (record.snapshot.kind === kind && record.snapshot.sessionName === sessionName) {
        this.activeRecords.delete(terminal);
        this.ignoredTerminals.add(terminal);
        unregistered += 1;
      }
    }

    const before = this.registeredSnapshots.length;
    this.registeredSnapshots = this.registeredSnapshots.filter((snapshot) => (
      snapshot.kind !== kind || snapshot.sessionName !== sessionName
    ));
    unregistered += before - this.registeredSnapshots.length;

    await this.context.workspaceState.update(WORKSPACE_TERMINAL_STATE_KEY, this.registeredSnapshots);
    this.refreshView();
    this.record('workspace.session.unregistered', { kind, sessionName, reason, unregistered });
    return unregistered;
  }

  public async renameSession(
    kind: MultiplexerKind,
    oldSessionName: string,
    newSessionName: string,
    reason = 'manual'
  ): Promise<number> {
    if (oldSessionName === newSessionName) {
      return 0;
    }

    const savedAt = nowIso();
    const renamedIds = new Set<string>();
    for (const record of this.activeRecords.values()) {
      if (record.snapshot.kind !== kind || record.snapshot.sessionName !== oldSessionName) {
        continue;
      }

      record.snapshot.sessionName = newSessionName;
      record.snapshot.name = terminalName(kind, newSessionName);
      record.snapshot.savedAt = savedAt;
      renamedIds.add(record.snapshot.id);
    }

    const renamedSnapshots = this.registeredSnapshots.map((snapshot) => {
      if (snapshot.kind !== kind || snapshot.sessionName !== oldSessionName) {
        return snapshot;
      }

      renamedIds.add(snapshot.id);
      return {
        ...snapshot,
        name: terminalName(kind, newSessionName),
        sessionName: newSessionName,
        savedAt
      };
    });

    this.registeredSnapshots = mergeRegisteredSnapshots(renamedSnapshots, this.activeSnapshots());
    await this.context.workspaceState.update(WORKSPACE_TERMINAL_STATE_KEY, this.registeredSnapshots);
    this.refreshView();
    this.record('workspace.session.renamed', {
      kind,
      oldSessionName,
      newSessionName,
      reason,
      renamed: renamedIds.size
    });
    return renamedIds.size;
  }

  public async closeSessionTerminals(kind: MultiplexerKind, sessionName: string, reason = 'manual'): Promise<number> {
    const closedSnapshots: WorkspaceTerminalSnapshot[] = [];
    for (const [terminal, record] of this.activeRecords) {
      if (record.snapshot.kind !== kind || record.snapshot.sessionName !== sessionName) {
        continue;
      }

      const closedAt = nowIso();
      record.snapshot.isOpen = false;
      record.snapshot.closedAt = closedAt;
      record.snapshot.savedAt = closedAt;
      this.activeRecords.delete(terminal);
      this.ignoredTerminals.add(terminal);
      closedSnapshots.push(record.snapshot);
      terminal.dispose();
    }

    if (closedSnapshots.length === 0) {
      return 0;
    }

    this.registeredSnapshots = mergeRegisteredSnapshots(this.registeredSnapshots, closedSnapshots);
    await this.context.workspaceState.update(WORKSPACE_TERMINAL_STATE_KEY, this.registeredSnapshots);
    this.refreshView();
    this.record('workspace.session.terminalsClosed', {
      kind,
      sessionName,
      reason,
      count: closedSnapshots.length
    });
    return closedSnapshots.length;
  }

  public async saveNow(reason = 'manual'): Promise<void> {
    const merged = mergeRegisteredSnapshots(this.registeredSnapshots, this.activeSnapshots());
    this.registeredSnapshots = pruneSnapshots(merged);
    await this.context.workspaceState.update(WORKSPACE_TERMINAL_STATE_KEY, this.registeredSnapshots);
    this.refreshView();
    this.record('workspace.state.saved', { reason, count: this.registeredSnapshots.length });
  }

  public toggleAutoSave(): boolean {
    if (this.autoSaveEnabled) {
      this.stopAutoSave();
      return false;
    }

    this.startAutoSave();
    return true;
  }

  public isAutoSaveEnabled(): boolean {
    return this.autoSaveEnabled;
  }

  public dispose(): void {
    this.stopAutoSave();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.onDidChangeTreeDataEmitter.dispose();
    this.onDidObserveMultiplexerCommandEmitter.dispose();
  }

  private trackExistingTerminals(): void {
    for (const terminal of vscode.window.terminals) {
      if (this.trackTerminal(terminal, 'detected')) {
        void this.updatePid(terminal);
      }
    }
  }

  private registerTerminalListeners(): void {
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        if (this.trackTerminal(terminal, 'detected')) {
          void this.updatePid(terminal);
          void this.saveNow('terminal.opened');
        }
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        if (this.markTerminalClosed(terminal)) {
          void this.saveNow('terminal.closed');
        }
      }),
      vscode.window.onDidChangeTerminalState((terminal) => {
        if (this.updateTrackedTerminal(terminal)) {
          void this.saveNow('terminal.stateChanged');
        }
      }),
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (terminal && this.updateTrackedTerminal(terminal)) {
          void this.saveNow('terminal.activeChanged');
        }
      }),
      vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (this.updateTrackedTerminal(event.terminal)) {
          void this.saveNow('terminal.shellIntegrationChanged');
        }
      }),
      vscode.window.onDidStartTerminalShellExecution((event) => {
        this.observeShellExecution(event.terminal, event.execution.commandLine.value);
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        this.observeShellExecution(event.terminal, event.execution.commandLine.value);
      })
    );
  }

  private observeShellExecution(terminal: vscode.Terminal, commandLine: string): void {
    const observation = inferMultiplexerCommand(commandLine, terminal.name);
    if (!observation) {
      if (this.updateTrackedTerminal(terminal, { lastCommandLine: commandLine })) {
        void this.saveNow('terminal.commandObserved');
      }
      return;
    }

    this.ignoredTerminals.delete(terminal);
    const record = this.updateTrackedTerminal(terminal, {
      kind: observation.kind,
      sessionName: observation.sessionName,
      lastCommandLine: commandLine
    });
    if (!record) {
      return;
    }

    record.snapshot.kind = observation.kind;
    record.snapshot.sessionName = observation.sessionName ?? record.snapshot.sessionName;
    record.snapshot.lastCommandLine = commandLine;
    record.snapshot.savedAt = nowIso();
    this.onDidObserveMultiplexerCommandEmitter.fire(observation);
    this.record('workspace.multiplexerCommandObserved', observation);
    void this.saveNow('terminal.multiplexerCommandObserved');
  }

  private trackTerminal(
    terminal: vscode.Terminal,
    source: TerminalLaunchSource,
    overrides: Partial<WorkspaceTerminalSnapshot> = {}
  ): WorkspaceTerminalSnapshot | undefined {
    if (this.ignoredTerminals.has(terminal) && !overrides.kind) {
      return undefined;
    }

    const existing = this.activeRecords.get(terminal);
    if (existing) {
      Object.assign(existing.snapshot, cleanSnapshotOverrides(overrides), {
        isOpen: true,
        savedAt: nowIso()
      });
      this.registeredSnapshots = mergeRegisteredSnapshots(this.registeredSnapshots, [existing.snapshot]);
      this.refreshView();
      return existing.snapshot;
    }

    const snapshot = this.createSnapshot(terminal, source, overrides);
    if (!snapshot) {
      return undefined;
    }
    this.activeRecords.set(terminal, { terminal, snapshot });
    this.registeredSnapshots = mergeRegisteredSnapshots(this.registeredSnapshots, [snapshot]);
    this.refreshView();
    return snapshot;
  }

  private updateTrackedTerminal(
    terminal: vscode.Terminal,
    overrides: Partial<WorkspaceTerminalSnapshot> = {}
  ): ActiveTerminalRecord | undefined {
    const record = this.activeRecords.get(terminal);
    if (!record) {
      const snapshot = this.trackTerminal(terminal, 'detected', overrides);
      return snapshot ? this.activeRecords.get(terminal) : undefined;
    }

    const updated = this.createSnapshot(terminal, record.snapshot.source, {
      ...record.snapshot,
      ...overrides,
      id: record.snapshot.id,
      openedAt: record.snapshot.openedAt
    });
    if (!updated) {
      return undefined;
    }
    record.snapshot = updated;
    this.activeRecords.set(terminal, record);
    this.refreshView();
    return record;
  }

  private createSnapshot(
    terminal: vscode.Terminal,
    source: TerminalLaunchSource,
    overrides: Partial<WorkspaceTerminalSnapshot> = {}
  ): WorkspaceTerminalSnapshot | undefined {
    const options = terminalOptions(terminal);
    const cwd = overrides.cwd ?? terminalCwd(terminal, options);
    const inferredKind = overrides.kind ?? kindFromTerminalName(terminal.name);
    if (!inferredKind) {
      return undefined;
    }
    const savedAt = nowIso();

    return {
      id: overrides.id ?? this.createId(),
      name: overrides.name ?? terminal.name,
      kind: inferredKind,
      source: overrides.source ?? source,
      isOpen: overrides.isOpen ?? true,
      sessionName: overrides.sessionName,
      cwd,
      shell: terminal.state.shell,
      shellPath: options?.shellPath,
      shellArgs: normalizeShellArgs(options?.shellArgs),
      lastCommandLine: overrides.lastCommandLine,
      pid: overrides.pid,
      location: overrides.location ?? serializeLocation(terminal.creationOptions.location),
      savedAt,
      openedAt: overrides.openedAt ?? savedAt,
      closedAt: overrides.closedAt
    };
  }

  private markTerminalClosed(terminal: vscode.Terminal): boolean {
    const record = this.activeRecords.get(terminal);
    if (!record) {
      return false;
    }

    record.snapshot.isOpen = false;
    record.snapshot.closedAt = nowIso();
    record.snapshot.savedAt = record.snapshot.closedAt;
    this.activeRecords.delete(terminal);
    this.registeredSnapshots = mergeRegisteredSnapshots(this.registeredSnapshots, [record.snapshot]);
    this.refreshView();
    this.record('workspace.terminal.closed', {
      id: record.snapshot.id,
      name: record.snapshot.name,
      kind: record.snapshot.kind
    });
    return true;
  }

  private async updatePid(terminal: vscode.Terminal): Promise<void> {
    const pid = await terminal.processId;
    const record = this.activeRecords.get(terminal);
    if (!record || !pid) {
      return;
    }

    record.snapshot.pid = pid;
    record.snapshot.savedAt = nowIso();
    this.registeredSnapshots = mergeRegisteredSnapshots(this.registeredSnapshots, [record.snapshot]);
    this.refreshView();
  }

  private async restoreSnapshot(snapshot: WorkspaceTerminalSnapshot, reveal: boolean): Promise<boolean> {
    if (!snapshot.sessionName || this.hasEquivalentOpenTerminal(snapshot)) {
      return false;
    }

    const shellPath = snapshot.shellPath ?? defaultShellPath(snapshot.kind);
    const terminal = vscode.window.createTerminal({
      name: snapshot.name,
      cwd: snapshot.cwd,
      shellPath,
      shellArgs: snapshot.shellArgs,
      location: locationForCreate(snapshot.location),
      isTransient: true
    });
    const openedAt = nowIso();
    this.trackTerminal(terminal, 'restored', {
      ...snapshot,
      isOpen: true,
      source: 'restored',
      openedAt,
      closedAt: undefined
    });

    const attachCommand = attachCommandFor(snapshot.kind, snapshot.sessionName, 'attach', shellPath);
    if (attachCommand) {
      terminal.sendText(attachCommand);
    }
    if (reveal) {
      terminal.show(false);
    }

    await this.updatePid(terminal);
    this.record('workspace.terminal.restored', {
      id: snapshot.id,
      name: snapshot.name,
      kind: snapshot.kind,
      sessionName: snapshot.sessionName
    });
    return true;
  }

  private hasEquivalentOpenTerminal(snapshot: WorkspaceTerminalSnapshot): boolean {
    return this.activeSnapshots().some((active) => registrationKey(active) === registrationKey(snapshot));
  }

  private restoreCandidates(): WorkspaceTerminalSnapshot[] {
    const activeKeys = new Set(this.activeSnapshots().map(registrationKey));
    return this.registeredSnapshots
      .filter((snapshot) => snapshot.sessionName && !activeKeys.has(registrationKey(snapshot)));
  }

  private findTerminalBySnapshotId(id: string): vscode.Terminal | undefined {
    for (const record of this.activeRecords.values()) {
      if (record.snapshot.id === id) {
        return record.terminal;
      }
    }
    return undefined;
  }

  private activeSnapshots(): WorkspaceTerminalSnapshot[] {
    return mergeRegisteredSnapshots(
      [],
      [...this.activeRecords.values()].map((record) => ({ ...record.snapshot, isOpen: true }))
    );
  }

  private allRegisteredSnapshots(): WorkspaceTerminalSnapshot[] {
    return mergeRegisteredSnapshots(this.registeredSnapshots, this.activeSnapshots());
  }

  private readRegisteredSnapshots(): WorkspaceTerminalSnapshot[] {
    return this.context.workspaceState
      .get<WorkspaceTerminalSnapshot[]>(WORKSPACE_TERMINAL_STATE_KEY, [])
      .filter(isRegisteredSnapshot);
  }

  private startAutoSave(): void {
    if (this.autoSaveTimer) {
      return;
    }

    this.autoSaveEnabled = true;
    this.autoSaveTimer = setInterval(() => {
      void this.saveNow('timer');
    }, autoSaveIntervalMs());
  }

  private stopAutoSave(): void {
    this.autoSaveEnabled = false;
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }
  }

  private autoRestoreEnabled(): boolean {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return configuration.get<boolean>(
      'autoAttachRememberedTerminals',
      configuration.get<boolean>('autoRestoreRegisteredTerminals', true)
    );
  }

  private createId(): string {
    const id = `${Date.now()}-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  private async pickTerminalKind(): Promise<WorkspaceTerminalKind | undefined> {
    const picked = await vscode.window.showQuickPick([
      { label: 'Zellij 会话终端', terminalKind: 'zellij' as const },
      { label: 'Tmux 会话终端', terminalKind: 'tmux' as const }
    ], {
      placeHolder: '选择要记住并管理的会话终端类型'
    });

    return picked?.terminalKind;
  }

  private async inputSessionName(kind: 'zellij' | 'tmux'): Promise<string | undefined> {
    const workspaceName = vscode.workspace.name ?? 'workspace';
    return vscode.window.showInputBox({
      prompt: `输入 ${kind} 会话名称`,
      value: `${workspaceName}-${kind}`,
      validateInput: (value) => value.trim() ? undefined : '会话名称不能为空。'
    });
  }
}

export class WorkspaceTerminalTreeItem extends vscode.TreeItem {
  public constructor(public readonly snapshot: WorkspaceTerminalSnapshot) {
    super(displayName(snapshot), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'workspaceTerminalOpen';
    this.description = terminalDescription(snapshot);
    this.iconPath = terminalIcon(snapshot);
    this.tooltip = terminalTooltip(snapshot);
    this.command = {
      command: COMMANDS.workspaceShow,
      title: '显示终端',
      arguments: [this]
    };
  }
}

function autoSaveIntervalMs(): number {
  return Math.max(
    1000,
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('autoSaveIntervalMs', 3000)
  );
}

function defaultWorkspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file')?.uri.fsPath;
}

function terminalName(kind: WorkspaceTerminalKind, sessionName?: string): string {
  return `${kind}: ${sessionName ?? 'session'}`;
}

function attachCommandFor(
  kind: WorkspaceTerminalKind,
  sessionName?: string,
  mode: 'attach' | 'createOrAttach' | 'none' = 'createOrAttach',
  shellPath?: string
): string | undefined {
  if (!sessionName) {
    return undefined;
  }
  if (mode === 'none') {
    return undefined;
  }
  const shellFlavor = terminalShellFlavor(shellPath);
  if (kind === 'zellij') {
    return mode === 'attach'
      ? buildZellijExistingSessionAttachCommand(sessionName, shellFlavor)
      : buildZellijAttachCommand(sessionName, shellFlavor);
  }
  if (kind === 'tmux') {
    return mode === 'attach'
      ? buildTmuxExistingSessionAttachCommand(sessionName, shellFlavor)
      : buildTmuxAttachCommand(sessionName, shellFlavor);
  }
}

function defaultShellPath(kind: WorkspaceTerminalKind): string | undefined {
  if (process.platform === 'win32' && kind === 'zellij') {
    return 'powershell.exe';
  }
  return undefined;
}

function terminalOptions(terminal: vscode.Terminal): Readonly<vscode.TerminalOptions> | undefined {
  const options = terminal.creationOptions;
  return 'pty' in options ? undefined : options;
}

function terminalCwd(terminal: vscode.Terminal, options: Readonly<vscode.TerminalOptions> | undefined): string | undefined {
  const integrationCwd = terminal.shellIntegration?.cwd;
  if (integrationCwd) {
    return integrationCwd.scheme === 'file' ? integrationCwd.fsPath : integrationCwd.toString();
  }

  const cwd = options?.cwd;
  if (!cwd) {
    return defaultWorkspaceCwd();
  }

  return typeof cwd === 'string'
    ? cwd
    : cwd.scheme === 'file' ? cwd.fsPath : cwd.toString();
}

function normalizeShellArgs(args: string[] | string | undefined): string[] | undefined {
  if (!args) {
    return undefined;
  }
  return Array.isArray(args) ? args : [args];
}

function serializeLocation(
  location: vscode.TerminalOptions['location'] | vscode.ExtensionTerminalOptions['location']
): SavedTerminalLocation {
  if (location === vscode.TerminalLocation.Editor) {
    return { kind: 'editor' };
  }
  if (location === vscode.TerminalLocation.Panel || location === undefined) {
    return { kind: 'panel' };
  }
  if ('viewColumn' in location) {
    return {
      kind: 'editor',
      viewColumn: location.viewColumn,
      preserveFocus: location.preserveFocus
    };
  }
  if ('parentTerminal' in location) {
    return { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

function locationForCreate(location: SavedTerminalLocation | undefined): vscode.TerminalOptions['location'] {
  const normalized = normalizeLocationKind(location);
  if (normalized.kind === 'editor') {
    return {
      viewColumn: normalized.viewColumn ?? vscode.ViewColumn.Active,
      preserveFocus: normalized.preserveFocus ?? true
    };
  }
  if (normalized.kind === 'panel') {
    return vscode.TerminalLocation.Panel;
  }
  return undefined;
}

function cleanSnapshotOverrides(overrides: Partial<WorkspaceTerminalSnapshot>): Partial<WorkspaceTerminalSnapshot> {
  const output = { ...overrides };
  for (const key of Object.keys(output) as Array<keyof WorkspaceTerminalSnapshot>) {
    if (output[key] === undefined) {
      delete output[key];
    }
  }
  return output;
}

function mergeSnapshots(
  existing: WorkspaceTerminalSnapshot[],
  updates: WorkspaceTerminalSnapshot[]
): WorkspaceTerminalSnapshot[] {
  const byId = new Map<string, WorkspaceTerminalSnapshot>();
  for (const snapshot of existing) {
    byId.set(snapshot.id, snapshot);
  }
  for (const snapshot of updates) {
    byId.set(snapshot.id, snapshot);
  }
  return [...byId.values()].sort((left, right) => right.savedAt.localeCompare(left.savedAt));
}

function mergeRegisteredSnapshots(
  existing: WorkspaceTerminalSnapshot[],
  updates: WorkspaceTerminalSnapshot[]
): WorkspaceTerminalSnapshot[] {
  const byRegistration = new Map<string, WorkspaceTerminalSnapshot>();
  for (const snapshot of mergeSnapshots(existing, updates).filter(isRegisteredSnapshot)) {
    const key = registrationKey(snapshot);
    if (!byRegistration.has(key)) {
      byRegistration.set(key, snapshot);
    }
  }
  return [...byRegistration.values()];
}

function pruneSnapshots(snapshots: WorkspaceTerminalSnapshot[]): WorkspaceTerminalSnapshot[] {
  return snapshots.slice(0, 50);
}

function displayName(snapshot: WorkspaceTerminalSnapshot): string {
  if (snapshot.sessionName) {
    return `${snapshot.sessionName}`;
  }
  return snapshot.name;
}

function terminalDescription(snapshot: WorkspaceTerminalSnapshot): string {
  const location = snapshot.location.kind;
  return `${snapshot.kind} · 已附加 · ${location}`;
}

function terminalIcon(snapshot: WorkspaceTerminalSnapshot): vscode.ThemeIcon {
  const color = new vscode.ThemeColor('terminal.ansiGreen');
  if (snapshot.kind === 'zellij') {
    return new vscode.ThemeIcon('terminal', color);
  }
  return new vscode.ThemeIcon('server', color);
}

function terminalTooltip(snapshot: WorkspaceTerminalSnapshot): vscode.MarkdownString {
  const lines = [
    `**Name:** ${snapshot.name}`,
    `**Kind:** ${snapshot.kind}`,
    `**Status:** ${snapshot.isOpen ? 'Attached terminal' : 'Last registered state'}`,
    snapshot.sessionName ? `**Session:** ${snapshot.sessionName}` : undefined,
    snapshot.cwd ? `**CWD:** ${snapshot.cwd}` : undefined,
    snapshot.shell ? `**Shell:** ${snapshot.shell}` : undefined,
    snapshot.pid ? `**PID:** ${snapshot.pid}` : undefined,
    `**Location:** ${snapshot.location.kind}`,
    snapshot.lastCommandLine ? `**Last Command:** ${snapshot.lastCommandLine}` : undefined,
    `**Updated:** ${snapshot.savedAt}`
  ].filter(Boolean);
  return new vscode.MarkdownString(lines.join('\n\n'));
}

function isRegisteredSnapshot(snapshot: WorkspaceTerminalSnapshot): boolean {
  return isRegisteredKind(snapshot.kind);
}

function registrationKey(snapshot: WorkspaceTerminalSnapshot): string {
  return snapshot.sessionName
    ? `${snapshot.kind}:${snapshot.sessionName}`
    : snapshot.id;
}

function isRegisteredKind(kind: unknown): kind is MultiplexerKind {
  return kind === 'zellij' || kind === 'tmux';
}

function nowIso(): string {
  return new Date().toISOString();
}
