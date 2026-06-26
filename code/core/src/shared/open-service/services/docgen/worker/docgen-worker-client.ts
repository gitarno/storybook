/**
 * Main-thread client for the long-lived docgen worker.
 *
 * Owns a single worker (docgen extraction serializes on one warm TypeScript program, so a pool
 * would only duplicate multi-second program builds and memory). Spawned once per process when the
 * compiled worker script is present; when it is missing — e.g. running from source without a build —
 * {@link createDocgenWorkerClient} returns `undefined` and the caller skips docgen registration
 * rather than silently extracting on the main thread.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { logger } from 'storybook/internal/node-logger';

import type { IndexEntry } from '../../../../../types/modules/indexer.ts';
import { importMetaResolve } from '../../../../utils/module.ts';
import type { ErrorLike } from '../../module-graph/types.ts';
import type { DocgenPayload, DocgenProviderDescriptor } from '../types.ts';
import type { DocgenWorkerRequest, DocgenWorkerResponse } from './protocol.ts';

/**
 * Package-relative specifier for the compiled worker. Resolved via the package export map (not a
 * hard-coded dist path) so strict package managers like pnpm resolve it correctly.
 */
const WORKER_SPECIFIER = 'storybook/internal/docgen-worker';

const DEFAULT_TASK_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (payload: DocgenPayload | undefined) => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
}

export interface DocgenWorkerClient {
  /** Extracts docgen for one component entry off the main thread. */
  extract(entry: IndexEntry): Promise<DocgenPayload | undefined>;
  dispose(): Promise<void>;
}

/** Rebuild an Error from a worker {@link ErrorLike} so the original name/message/stack survive. */
function errorLikeToError(errorLike: ErrorLike): Error {
  const error = new Error(errorLike.message);
  if (errorLike.name) {
    error.name = errorLike.name;
  }
  if (errorLike.stack) {
    error.stack = errorLike.stack;
  }
  return error;
}

class DocgenWorker implements DocgenWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<void>;
  private nextId = 0;
  private disposed = false;

  constructor(
    scriptPath: string,
    descriptors: DocgenProviderDescriptor[],
    private readonly taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS
  ) {
    this.worker = new Worker(scriptPath);
    // Never let an idle worker keep the process alive.
    this.worker.unref();
    this.worker.on('message', (msg: DocgenWorkerResponse) => this.handleMessage(msg));
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.disposed) {
        this.fail(new Error(`docgen worker exited unexpectedly with code ${code}`));
      }
    });

    this.ready = new Promise<void>((resolve, reject) => {
      const onMessage = (msg: DocgenWorkerResponse) => {
        if (msg.type !== 'init') {
          return;
        }
        this.worker.off('message', onMessage);
        if (msg.error) {
          reject(errorLikeToError(msg.error));
        } else {
          resolve();
        }
      };
      this.worker.on('message', onMessage);
    });
    // Surface late init rejections instead of leaving an unhandled rejection.
    this.ready.catch(() => undefined);

    this.post({ type: 'init', descriptors });
  }

  async extract(entry: IndexEntry): Promise<DocgenPayload | undefined> {
    if (this.disposed) {
      throw new Error('docgen worker disposed');
    }
    await this.ready;
    return new Promise<DocgenPayload | undefined>((resolve, reject) => {
      const id = this.nextId++;
      const pending: Pending = { resolve, reject };
      if (this.taskTimeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`docgen worker extract ${id} timed out after ${this.taskTimeoutMs}ms`));
        }, this.taskTimeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      this.post({ type: 'extract', id, entry });
    });
  }

  private post(msg: DocgenWorkerRequest): void {
    this.worker.postMessage(msg);
  }

  private handleMessage(msg: DocgenWorkerResponse): void {
    if (msg.type !== 'extract') {
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(errorLikeToError(msg.error));
    } else {
      pending.resolve(msg.payload);
    }
  }

  /** Reject everything in flight and tear the worker down; used on fatal worker failure. */
  private fail(error: Error): void {
    if (this.disposed) {
      return;
    }
    logger.debug(`docgen worker failure: ${error.message}`);
    this.disposed = true;
    this.rejectAllPending(error);
    this.worker.terminate().catch(() => 0);
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rejectAllPending(new Error('docgen worker disposed'));
    await this.worker.terminate().catch(() => 0);
  }
}

function resolveWorkerScriptPath(): string | undefined {
  try {
    const scriptPath = fileURLToPath(importMetaResolve(WORKER_SPECIFIER));
    return existsSync(scriptPath) ? scriptPath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates the docgen worker client and kicks off chain composition with `descriptors`. Returns
 * `undefined` when the compiled worker script is unavailable (no fallback — the caller skips docgen
 * registration). Best-effort disposes the worker on process exit.
 */
export function createDocgenWorkerClient(
  descriptors: DocgenProviderDescriptor[]
): DocgenWorkerClient | undefined {
  const scriptPath = resolveWorkerScriptPath();
  if (!scriptPath) {
    logger.debug(
      'docgen worker disabled: compiled worker script not found (running from source without a build?)'
    );
    return undefined;
  }

  let client: DocgenWorker;
  try {
    client = new DocgenWorker(scriptPath, descriptors);
  } catch (error) {
    logger.debug(
      `docgen worker disabled: failed to spawn (${error instanceof Error ? error.message : String(error)})`
    );
    return undefined;
  }

  const disposeOnExit = () => {
    void client.dispose();
  };
  process.once('exit', disposeOnExit);
  process.once('SIGINT', disposeOnExit);
  process.once('SIGTERM', disposeOnExit);

  return client;
}
