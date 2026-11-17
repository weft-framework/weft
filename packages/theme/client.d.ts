export interface SetThemeOptions {
  cookie?: string;
  maxAge?: number;
}

export function getTheme(): string;
export function isDark(): boolean;
export function setTheme(name: string, options?: SetThemeOptions): string;
export function cycleTheme(names: readonly string[], options?: SetThemeOptions): string;
