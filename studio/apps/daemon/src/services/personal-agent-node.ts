import { randomUUID } from "node:crypto";
import type {
  PaEntity,
  PaExecutionLease,
  PaNode,
  PaNodeEvent,
  PaExecutor,
} from "@open-design/contracts";
import { PaError, PaStore } from "../storage/personal-agent-store.js";

type StoredLease = PaEntity & {
  lease: PaExecutionLease;
  state: "active" | "cancel_requested" | "released" | "expired";
  expiresAt: number;
};
const LEASE_MS = 45000;

/** The live claimant is process-scoped; its generation and expiry are persisted. */
export class PaLocalNode implements PaExecutor {
  readonly id: string;
  private leases = new Map<string, PaExecutionLease>();
  constructor(
    private store: PaStore,
    private onCancel: (lease: PaExecutionLease) => void = () => {},
  ) {
    const settings =
      store.get<PaEntity & { nodeId: string }>("settings", "node") ??
      store.create<PaEntity & { nodeId: string }>(
        "settings",
        { nodeId: randomUUID() },
        "node",
      );
    this.id = settings.nodeId;
    store.transaction(() => {
      for (const record of store.list<StoredLease>("leases"))
        if (record.state === "active" || record.state === "cancel_requested")
          store.update<StoredLease>("leases", record.id, { state: "expired" });
    });
  }
  capabilities(): PaNode {
    return {
      id: this.id,
      location: "local",
      available: true,
      protocolVersion: 1,
      capabilities: ["text", "project-files", "cancel", "review"],
      heartbeatAt: Date.now(),
    };
  }
  claim(lease: PaExecutionLease, capability = "text"): boolean {
    if (
      lease.protocolVersion !== 1 ||
      lease.nodeId !== this.id ||
      !this.capabilities().capabilities.includes(capability)
    )
      return false;
    if (this.leases.has(lease.attemptId)) return false;
    const claimed = this.store.transaction(() => {
      if (this.store.get<StoredLease>("leases", lease.attemptId) || this.store.hasEvent(lease.idempotencyKey)) return false;
      this.store.create<StoredLease>("leases", { lease, state: "active", expiresAt: Date.now() + LEASE_MS }, lease.attemptId);
      return this.store.event(lease.taskId, "node.claimed", lease, lease.idempotencyKey);
    });
    if (!claimed) return false;
    this.leases.set(lease.attemptId, lease);
    return true;
  }
  event(event: PaNodeEvent): boolean {
    const lease = this.leases.get(event.lease.attemptId);
    const record = this.store.get<StoredLease>("leases", event.lease.attemptId);
    if (!lease || !record || record.expiresAt <= Date.now() ||
      (record.state !== "active" && !(record.state === "cancel_requested" && event.kind === "cancelled")) ||
      JSON.stringify(lease) !== JSON.stringify(event.lease))
      throw new PaError("执行节点租约已失效", 409, "PA_STALE_LEASE");
    return this.store.event(
      lease.taskId,
      `node.${event.kind}`,
      event,
      event.eventId,
    );
  }
  heartbeat(lease: PaExecutionLease): boolean {
    if (
      JSON.stringify(this.leases.get(lease.attemptId)) !== JSON.stringify(lease)
    )
      return false;
    return this.store.transaction(() => {
      const record = this.store.get<StoredLease>("leases", lease.attemptId);
      const now = Date.now();
      if (record?.state !== "active" || record.expiresAt <= now) return false;
      this.store.update<StoredLease>("leases", lease.attemptId, { expiresAt: now + LEASE_MS }, record.revision);
      return this.event({ lease, eventId: randomUUID(), kind: "heartbeat", at: now });
    });
  }
  cancel(lease: PaExecutionLease): { confirmed: boolean } {
    if (
      JSON.stringify(this.leases.get(lease.attemptId)) !== JSON.stringify(lease)
    )
      return { confirmed: false };
    this.store.transaction(() => {
      const record = this.store.require<StoredLease>("leases", lease.attemptId);
      if (record.state === "active") this.store.update<StoredLease>("leases", lease.attemptId, { state: "cancel_requested" });
      this.store.event(lease.taskId, "node.cancel_requested", lease, `${lease.attemptId}:cancel-request`);
    });
    this.onCancel(lease);
    // Acceptance is not termination evidence. The executor emits cancelled only
    // after its process has exited; unknown remote termination stays unknown.
    return { confirmed: false };
  }
  cancelTask(taskId: string): void {
    for (const lease of this.leases.values())
      if (lease.taskId === taskId) this.cancel(lease);
  }
  release(lease: PaExecutionLease): void {
    this.leases.delete(lease.attemptId);
    const record = this.store.get<StoredLease>("leases", lease.attemptId);
    if (record && record.state !== "released") this.store.update<StoredLease>("leases", lease.attemptId, { state: "released" });
  }
}
