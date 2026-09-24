declare module 'node-red-node-test-helper' {
  import type { NodeAPI } from 'node-red';
  interface TestNode {
    id: string;
    on(event: string, cb: (...args: never[]) => void): void;
    receive(msg: Record<string, unknown>): void;
    send(msg: unknown): void;
    status(s: unknown): void;
    error(err: unknown, msg?: unknown): void;
    warn(msg: unknown): void;
  }
  interface Helper {
    init(runtimePath: string, userSettings?: Record<string, unknown>): void;
    load(
      nodes: ((RED: NodeAPI) => void) | Array<(RED: NodeAPI) => void>,
      flow: unknown[],
      credentials?: unknown,
    ): Promise<void>;
    unload(): Promise<void>;
    getNode(id: string): TestNode;
    startServer(done?: () => void): Promise<void> | void;
    stopServer(done?: () => void): Promise<void> | void;
    settings(settings: Record<string, unknown>): void;
    log(): unknown;
  }
  const helper: Helper;
  export default helper;
}
