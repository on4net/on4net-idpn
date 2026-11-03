import type { KeyRotationResult } from './key-types.js';
import type { SigningKeyManager } from './keys.js';

export interface KeyRotationSchedulerOptions {
  keys: SigningKeyManager;
  /** Days between automatic rotations; `0` disables the scheduler entirely. */
  intervalDays: number;
  /** How often the scheduler checks the active key age; defaults to one hour. */
  checkIntervalMs?: number;
  /** Environment used to keep timers out of test builds; defaults to `NODE_ENV`. */
  nodeEnv?: string | undefined;
  /** Explicit opt-in/out, mostly for tests. */
  enabled?: boolean;
  /** Called after a rotation, e.g. to write the `key.rotate` audit event. */
  onRotated?: (result: KeyRotationResult) => void | Promise<void>;
  /** Receives scheduler failures; never receives key material. */
  onError?: (error: Error) => void;
}

const DEFAULT_CHECK_INTERVAL_MS = 3_600_000;

/**
 * Automatic signing-key rotation (docs/architecture.md 5: rotate every 90 days).
 *
 * The timer is never started by `buildServer`, and `start()` is a no-op in a test build,
 * so a unit/integration test cannot accidentally schedule rotations. `tick()` is public so
 * tests drive rotation deterministically without fake timers.
 */
export class KeyRotationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly checkIntervalMs: number;
  private readonly enabled: boolean;

  constructor(private readonly options: KeyRotationSchedulerOptions) {
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV'];
    this.enabled = options.intervalDays > 0 && nodeEnv !== 'test' && (options.enabled ?? true);
  }

  /** True when the scheduler runs (interval configured and not a test build). */
  get isEnabled(): boolean {
    return this.enabled;
  }

  start(): void {
    if (!this.enabled || this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.options.onError?.(toError(error));
      });
    }, this.checkIntervalMs);
    // Do not keep the process alive only for key rotation.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Rotates when the active key is older than the configured interval. Returns the
   * rotation result, or `null` when the key is still fresh or rotation is disabled.
   */
  async tick(): Promise<KeyRotationResult | null> {
    if (!this.enabled) {
      return null;
    }
    const health = await this.options.keys.inspect();
    if (!health.rotationDue) {
      return null;
    }
    const result = await this.options.keys.rotate();
    await this.options.onRotated?.(result);
    return result;
  }
}

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));
