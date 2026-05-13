import type { BotTransport } from './types';

export interface RuntimeIssueCardLockKey {
  transport: BotTransport;
  conversation_id: string;
  issue_id: string;
}

export interface RuntimeIssueCardConversationLockKey {
  transport: BotTransport;
  conversation_id: string;
}

export class RuntimeIssueCardLock {
  private readonly locks = new Map<string, number>();

  acquire(key: RuntimeIssueCardLockKey): () => void {
    const lockKey = this.key(key);
    return this.acquireKey(lockKey);
  }

  acquireConversation(key: RuntimeIssueCardConversationLockKey): () => void {
    return this.acquireKey(this.conversationKey(key));
  }

  isLocked(key: RuntimeIssueCardLockKey): boolean {
    return this.locks.has(this.key(key)) || this.locks.has(this.conversationKey(key));
  }

  isConversationLocked(key: RuntimeIssueCardConversationLockKey): boolean {
    return this.locks.has(this.conversationKey(key));
  }

  clear(): void {
    this.locks.clear();
  }

  private acquireKey(lockKey: string): () => void {
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

  private key(key: RuntimeIssueCardLockKey): string {
    return ['issue', key.transport, key.conversation_id, key.issue_id].join(':');
  }

  private conversationKey(key: RuntimeIssueCardConversationLockKey): string {
    return ['conversation', key.transport, key.conversation_id].join(':');
  }
}
