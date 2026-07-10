declare module 'node:sqlite' {
  export interface StatementSync {
    all(...anonymousParameters: unknown[]): Array<Record<string, unknown>>;
    get(...anonymousParameters: unknown[]): Record<string, unknown> | undefined;
    run(...anonymousParameters: unknown[]): {
      changes: number;
      lastInsertRowid: number | bigint;
    };
    setAllowBareNamedParameters(enabled: boolean): void;
    setReadBigInts(enabled: boolean): void;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
    timeout?: number;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    function(name: string, callback: (...args: unknown[]) => unknown): void;
  }
}
