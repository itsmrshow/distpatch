import { advisoryLockKey, ROUTER_LOCK_CLASS } from "./advisory-lock"
import {
  createSessionAdvisoryLockPool,
  type SessionAdvisoryLockPoolOptions,
} from "./session-advisory-lock"

export type CapabilitySyncLockPoolOptions = Omit<SessionAdvisoryLockPoolOptions, "lockClass">
/**
 * `acquired: false` means a sync still occupies this lock: either another session holds it,
 * or this process's earlier sync callback has not settled (its session may already be lost and
 * is fenced out of every write). Acquisition that merely timed out or was aborted is an error.
 */
type CapabilitySyncLockResult<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false }
export interface CapabilitySyncLockPoolHandle {
  tryRun<T>(
    work: (lockSignal: AbortSignal, backendPid: number) => Promise<T>,
  ): Promise<CapabilitySyncLockResult<T>>
  close(): Promise<void>
}

export const CAPABILITY_SYNC_LOCK_KEY = advisoryLockKey("capability_intelligence_sync")

/** Capability sync uses the router lock namespace on its own hardened session pool. */
export function createCapabilitySyncLockPool(
  options: CapabilitySyncLockPoolOptions,
): CapabilitySyncLockPoolHandle {
  const pool = createSessionAdvisoryLockPool({ ...options, lockClass: ROUTER_LOCK_CLASS })
  const neverAbortedSignal = new AbortController().signal
  return {
    tryRun: async (work) => {
      const result = await pool.tryRun(CAPABILITY_SYNC_LOCK_KEY, neverAbortedSignal, work)
      if (result.acquired) return result
      if (result.reason !== "aborted") return { acquired: false }
      throw new Error("Capability sync lock acquisition was aborted or timed out")
    },
    close: pool.close,
  }
}
