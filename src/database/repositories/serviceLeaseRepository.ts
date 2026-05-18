/**
 * Service Lease Repository - singleton leadership leases for orchestrator processes
 */

import type { Database } from 'bun:sqlite';
import type { AcquireServiceLeaseResult, ServiceLease } from '../types';

export class ServiceLeaseRepository {
  constructor(private db: Database) {}

  acquire(params: {
    lease_key: string;
    holder_id: string;
    holder_pid?: number | null;
    holder_host?: string | null;
    metadata_json?: Record<string, unknown> | null;
    ttl_ms: number;
    now?: Date;
  }): AcquireServiceLeaseResult {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const expiresAtIso = new Date(now.getTime() + params.ttl_ms).toISOString();
    const metadataJson = params.metadata_json
      ? JSON.stringify(params.metadata_json)
      : null;

    return this.db.transaction(() => {
      const existing = this.findByKey(params.lease_key);
      if (!existing) {
        this.db.prepare(`
          INSERT INTO service_leases (
            lease_key, holder_id, holder_pid, holder_host, metadata_json,
            acquired_at, heartbeat_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          params.lease_key,
          params.holder_id,
          params.holder_pid ?? null,
          params.holder_host ?? null,
          metadataJson,
          nowIso,
          nowIso,
          expiresAtIso,
        );

        return {
          acquired: true,
          lease: this.findByKey(params.lease_key),
        };
      }

      if (
        existing.holder_id === params.holder_id ||
        existing.expires_at.getTime() <= now.getTime()
      ) {
        this.db.prepare(`
          UPDATE service_leases
          SET holder_id = ?,
              holder_pid = CASE WHEN holder_id = ? THEN COALESCE(?, holder_pid) ELSE ? END,
              holder_host = CASE WHEN holder_id = ? THEN COALESCE(?, holder_host) ELSE ? END,
              metadata_json = CASE WHEN holder_id = ? THEN COALESCE(?, metadata_json) ELSE ? END,
              acquired_at = CASE WHEN holder_id = ? THEN acquired_at ELSE ? END,
              heartbeat_at = ?,
              expires_at = ?
          WHERE lease_key = ?
        `).run(
          params.holder_id,
          params.holder_id,
          params.holder_pid ?? null,
          params.holder_pid ?? null,
          params.holder_id,
          params.holder_host ?? null,
          params.holder_host ?? null,
          params.holder_id,
          metadataJson,
          metadataJson,
          params.holder_id,
          nowIso,
          nowIso,
          expiresAtIso,
          params.lease_key,
        );

        return {
          acquired: true,
          lease: this.findByKey(params.lease_key),
        };
      }

      return {
        acquired: false,
        lease: existing,
      };
    })();
  }

  renew(params: {
    lease_key: string;
    holder_id: string;
    ttl_ms: number;
    now?: Date;
  }): AcquireServiceLeaseResult {
    return this.acquire({
      lease_key: params.lease_key,
      holder_id: params.holder_id,
      ttl_ms: params.ttl_ms,
      now: params.now,
    });
  }

  release(lease_key: string, holder_id: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM service_leases
      WHERE lease_key = ? AND holder_id = ?
    `).run(lease_key, holder_id);
    return (result as { changes: number }).changes > 0;
  }

  findByKey(lease_key: string): ServiceLease | null {
    const row = this.db.prepare(`
      SELECT * FROM service_leases WHERE lease_key = ?
    `).get(lease_key) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      lease_key: row.lease_key as string,
      holder_id: row.holder_id as string,
      holder_pid: (row.holder_pid as number | null) ?? null,
      holder_host: (row.holder_host as string | null) ?? null,
      metadata_json: row.metadata_json
        ? JSON.parse(row.metadata_json as string) as Record<string, unknown>
        : null,
      acquired_at: new Date(row.acquired_at as string),
      heartbeat_at: new Date(row.heartbeat_at as string),
      expires_at: new Date(row.expires_at as string),
    };
  }
}
