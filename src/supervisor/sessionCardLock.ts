import type { BotTransport } from '../bots/types';

export interface SupervisorSessionCardLockKey {
  transport: BotTransport;
  conversation_id: string;
  session_id: string;
}

export class SupervisorSessionCardLock {
  private readonly locks = new Map<string, number>();

  acquire(key: SupervisorSessionCardLockKey): () => void {
    const lockKey = this.key(key);
    this.locks.set(lockKey, (this.locks.get(lockKey) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const count = this.locks.get(lockKey) ?? 0;
      if (count <= 1) {
        this.locks.delete(lockKey);
        return;
      }
      this.locks.set(lockKey, count - 1);
    };
  }

  isLocked(key: SupervisorSessionCardLockKey): boolean {
    return this.locks.has(this.key(key));
  }

  clear(): void {
    this.locks.clear();
  }

  private key(key: SupervisorSessionCardLockKey): string {
    return [key.transport, key.conversation_id, key.session_id].join(':');
  }
}
