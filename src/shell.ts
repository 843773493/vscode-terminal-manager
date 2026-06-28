import type { MultiplexerCommandObservation, MultiplexerKind, SavedTerminalLocation } from './types';

export type TerminalShellFlavor = 'posix' | 'powershell';

export function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function terminalShellFlavor(shellPath: string | undefined, platform = process.platform): TerminalShellFlavor {
  if (platform === 'win32') {
    return 'powershell';
  }
  if (shellPath && /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shellPath)) {
    return 'powershell';
  }
  return 'posix';
}

export function quoteForTerminalShell(value: string, flavor: TerminalShellFlavor): string {
  return flavor === 'powershell'
    ? quoteForPowerShell(value)
    : quoteForPosixShell(value);
}

export function buildTmuxAttachCommand(sessionName: string, flavor: TerminalShellFlavor = terminalShellFlavor(undefined)): string {
  return `tmux new-session -A -s ${quoteForTerminalShell(sessionName, flavor)}`;
}

export function buildTmuxExistingSessionAttachCommand(sessionName: string, flavor: TerminalShellFlavor = terminalShellFlavor(undefined)): string {
  return `tmux attach -t ${quoteForTerminalShell(sessionName, flavor)}`;
}

export function buildZellijAttachCommand(sessionName: string, flavor: TerminalShellFlavor = terminalShellFlavor(undefined)): string {
  return `zellij attach --create ${quoteForTerminalShell(sessionName, flavor)}`;
}

export function buildZellijExistingSessionAttachCommand(sessionName: string, flavor: TerminalShellFlavor = terminalShellFlavor(undefined)): string {
  return `zellij attach ${quoteForTerminalShell(sessionName, flavor)}`;
}

export function splitShellLike(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += '\\';
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function inferMultiplexerCommand(commandLine: string, terminalName: string): MultiplexerCommandObservation | undefined {
  const tokens = splitShellLike(commandLine);
  const zellijIndex = tokens.findIndex((token) => token === 'zellij');
  if (zellijIndex >= 0) {
    return {
      kind: 'zellij',
      commandLine,
      terminalName,
      sessionName: extractZellijSession(tokens.slice(zellijIndex + 1))
    };
  }

  const tmuxIndex = tokens.findIndex((token) => token === 'tmux');
  if (tmuxIndex >= 0) {
    return {
      kind: 'tmux',
      commandLine,
      terminalName,
      sessionName: extractTmuxSession(tokens.slice(tmuxIndex + 1))
    };
  }

  return undefined;
}

export function normalizeLocationKind(location: SavedTerminalLocation | undefined): SavedTerminalLocation {
  return location ?? { kind: 'panel' };
}

function extractZellijSession(args: string[]): string | undefined {
  const rootSession = flagValue(args, ['-s', '--session']);
  if (rootSession) {
    return rootSession;
  }

  const commandIndex = args.findIndex((token) => !token.startsWith('-'));
  if (commandIndex < 0) {
    return undefined;
  }

  const command = args[commandIndex];
  if (!['attach', 'a', 'kill-session', 'k', 'delete-session', 'd', 'watch', 'w'].includes(command)) {
    return undefined;
  }

  const commandArgs = args.slice(commandIndex + 1);
  const positional = commandArgs.find((token) => !token.startsWith('-'));
  return positional;
}

function extractTmuxSession(args: string[]): string | undefined {
  const commandIndex = args.findIndex((token) => !token.startsWith('-'));
  if (commandIndex < 0) {
    return flagValue(args, ['-t', '-s']);
  }

  const command = normalizeTmuxCommand(args[commandIndex]);
  const commandArgs = args.slice(commandIndex + 1);

  if (['new-session', 'new'].includes(command)) {
    return flagValue(commandArgs, ['-s', '-t']);
  }

  if (['attach-session', 'attach', 'kill-session', 'rename-session'].includes(command)) {
    return flagValue(commandArgs, ['-t']);
  }

  if (['new-window', 'rename-window', 'kill-window', 'split-window', 'select-window', 'select-pane', 'kill-pane'].includes(command)) {
    const target = flagValue(commandArgs, ['-t']);
    return target?.split(':')[0]?.split('.')[0];
  }

  return flagValue(commandArgs, ['-t', '-s']);
}

function normalizeTmuxCommand(command: string): string {
  const aliases = new Map<string, string>([
    ['new', 'new-session'],
    ['neww', 'new-window'],
    ['attach', 'attach-session'],
    ['a', 'attach-session'],
    ['killw', 'kill-window'],
    ['killp', 'kill-pane'],
    ['splitw', 'split-window'],
    ['renamew', 'rename-window'],
    ['rename', 'rename-session'],
    ['selectw', 'select-window'],
    ['selectp', 'select-pane']
  ]);

  return aliases.get(command) ?? command;
}

function flagValue(args: string[], flags: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const [name, inlineValue] = token.split('=', 2);
    if (flags.includes(name) && inlineValue) {
      return inlineValue;
    }

    if (flags.includes(token)) {
      return args[index + 1];
    }
  }

  return undefined;
}

export function kindFromTerminalName(name: string): MultiplexerKind | undefined {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('zellij')) {
    return 'zellij';
  }
  if (lowerName.includes('tmux')) {
    return 'tmux';
  }
  return undefined;
}
