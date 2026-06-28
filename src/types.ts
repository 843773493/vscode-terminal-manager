export type MultiplexerKind = 'zellij' | 'tmux';
export type WorkspaceTerminalKind = MultiplexerKind;
export type TerminalLaunchSource = 'detected' | 'extension' | 'restored';

export interface DiagnosticEvent {
  at: string;
  name: string;
  data?: unknown;
}

export interface SavedTerminalLocation {
  kind: 'panel' | 'editor' | 'unknown';
  viewColumn?: number;
  preserveFocus?: boolean;
}

export interface WorkspaceTerminalSnapshot {
  id: string;
  name: string;
  kind: WorkspaceTerminalKind;
  source: TerminalLaunchSource;
  isOpen: boolean;
  sessionName?: string;
  cwd?: string;
  shell?: string;
  shellPath?: string;
  shellArgs?: string[];
  lastCommandLine?: string;
  pid?: number;
  location: SavedTerminalLocation;
  savedAt: string;
  openedAt?: string;
  closedAt?: string;
}

export interface MultiplexerCommandObservation {
  kind: MultiplexerKind;
  commandLine: string;
  sessionName?: string;
  terminalName: string;
}

export interface TmuxPane {
  sessionName: string;
  windowIndex: string;
  index: string;
  command: string;
  currentPath: string;
  isActive: boolean;
  pid: number;
}

export interface TmuxWindow {
  sessionName: string;
  index: string;
  name: string;
  isActive: boolean;
  panes: TmuxPane[];
}

export interface TmuxSession {
  name: string;
  isAttached: boolean;
  created: string;
  lastActivity: string;
  windows: TmuxWindow[];
}

export interface ZellijSession {
  name: string;
  status: 'running' | 'exited' | 'unknown';
  createdSummary?: string;
  raw: string;
}

export interface BackendState<TSession> {
  installed: boolean;
  autoRefreshEnabled: boolean;
  lastError?: string;
  sessions: TSession[];
}

export interface WorkspaceState {
  autoSaveEnabled: boolean;
  autoRestoreEnabled: boolean;
  restoredThisActivation: boolean;
  activeTerminals: WorkspaceTerminalSnapshot[];
  registeredTerminals: WorkspaceTerminalSnapshot[];
}

export interface TerminalManagerState {
  status: string;
  logFile: string;
  events: DiagnosticEvent[];
  workspace: WorkspaceState;
  zellij: BackendState<ZellijSession>;
  tmux: BackendState<TmuxSession>;
}

export interface CreateTerminalRequest {
  kind?: WorkspaceTerminalKind;
  sessionName?: string;
  cwd?: string;
  shellPath?: string;
  shellArgs?: string[];
  reveal?: boolean;
  location?: SavedTerminalLocation;
  attachMode?: 'attach' | 'createOrAttach' | 'none';
}
