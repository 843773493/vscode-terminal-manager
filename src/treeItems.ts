import * as vscode from 'vscode';

export class MessageTreeItem extends vscode.TreeItem {
  public constructor(label: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'terminalManagerMessage';
  }
}
