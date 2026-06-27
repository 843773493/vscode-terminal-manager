export const EXTENSION_ID = 'vscode-terminal-manager';
export const VIEW_CONTAINER_ID = 'terminalManager';
export const WORKSPACE_VIEW_ID = 'vscodeTerminalManager.workspace';
export const ZELLIJ_VIEW_ID = 'vscodeTerminalManager.zellij';
export const TMUX_VIEW_ID = 'vscodeTerminalManager.tmux';
export const CONFIG_SECTION = 'vscodeTerminalManager';
export const OUTPUT_CHANNEL_NAME = 'VS Code Terminal Manager';

export const COMMANDS = {
  openSidebar: `${EXTENSION_ID}.openSidebar`,
  refreshAll: `${EXTENSION_ID}.refreshAll`,
  dumpState: `${EXTENSION_ID}.dumpState`,
  emitTestLog: `${EXTENSION_ID}.emitTestLog`,
  workspaceCreate: `${EXTENSION_ID}.workspace.create`,
  workspaceRefresh: `${EXTENSION_ID}.workspace.refresh`,
  workspaceToggleAutoSave: `${EXTENSION_ID}.workspace.toggleAutoSave`,
  workspaceSave: `${EXTENSION_ID}.workspace.save`,
  workspaceShow: `${EXTENSION_ID}.workspace.show`,
  workspaceRestoreRegistered: `${EXTENSION_ID}.workspace.restoreRegistered`,
  workspaceKill: `${EXTENSION_ID}.workspace.kill`,
  zellijNew: `${EXTENSION_ID}.zellij.new`,
  zellijAttach: `${EXTENSION_ID}.zellij.attach`,
  zellijKill: `${EXTENSION_ID}.zellij.kill`,
  zellijDelete: `${EXTENSION_ID}.zellij.delete`,
  zellijRefresh: `${EXTENSION_ID}.zellij.refresh`,
  zellijToggleAutoRefresh: `${EXTENSION_ID}.zellij.toggleAutoRefresh`,
  tmuxNew: `${EXTENSION_ID}.tmux.new`,
  tmuxAttach: `${EXTENSION_ID}.tmux.attach`,
  tmuxRename: `${EXTENSION_ID}.tmux.rename`,
  tmuxRenameWindow: `${EXTENSION_ID}.tmux.renameWindow`,
  tmuxNewWindow: `${EXTENSION_ID}.tmux.newWindow`,
  tmuxKillSession: `${EXTENSION_ID}.tmux.killSession`,
  tmuxKillWindow: `${EXTENSION_ID}.tmux.killWindow`,
  tmuxKillPane: `${EXTENSION_ID}.tmux.killPane`,
  tmuxSplitPaneRight: `${EXTENSION_ID}.tmux.splitPaneRight`,
  tmuxSplitPaneDown: `${EXTENSION_ID}.tmux.splitPaneDown`,
  tmuxRefresh: `${EXTENSION_ID}.tmux.refresh`,
  tmuxToggleAutoRefresh: `${EXTENSION_ID}.tmux.toggleAutoRefresh`
} as const;

export const WORKBENCH_VIEW_COMMAND = `workbench.view.extension.${VIEW_CONTAINER_ID}`;
export const WORKSPACE_TERMINAL_STATE_KEY = 'workspaceTerminalSnapshots';
