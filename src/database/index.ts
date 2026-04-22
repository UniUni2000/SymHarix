/**
 * Database Connection Module for Symphony Enterprise Agent Platform
 * Provides SQLite database connection with WAL mode for concurrency
 */

import { Database } from 'bun:sqlite';
import { initializeSchema, dropAllTables } from './schema';

/**
 * Database configuration options
 */
export interface DatabaseConfig {
  /** Path to the SQLite database file */
  path: string;
  /** Enable WAL mode for better concurrency (default: true) */
  walMode?: boolean;
  /** Create database if it doesn't exist (default: true) */
  createIfMissing?: boolean;
}

/**
 * Default database configuration
 */
const DEFAULT_CONFIG: DatabaseConfig = {
  path: './symphony.db',
  walMode: true,
  createIfMissing: true,
};

/**
 * Singleton database instance
 */
let dbInstance: Database | null = null;

/**
 * Create and configure database connection
 * Uses WAL mode for better write concurrency
 */
export function createDatabase(config: Partial<DatabaseConfig> = {}): Database {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  // Close existing connection if any
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore close errors
    }
    dbInstance = null;
  }

  // Create new database connection
  dbInstance = new Database(finalConfig.path);

  // Enable WAL mode for better concurrency
  if (finalConfig.walMode) {
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA synchronous = NORMAL;');
    dbInstance.exec('PRAGMA cache_size = 10000;');
    dbInstance.exec('PRAGMA temp_store = memory;');
  }

  // Enable foreign keys
  dbInstance.exec('PRAGMA foreign_keys = ON;');

  // Initialize schema
  initializeSchema(dbInstance);

  return dbInstance;
}

/**
 * Get the current database instance
 * Creates a new connection if none exists
 */
export function getDatabase(config: Partial<DatabaseConfig> = {}): Database {
  if (!dbInstance) {
    return createDatabase(config);
  }
  return dbInstance;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Reset database for testing
 * Drops all tables and reinitializes schema
 */
export function resetDatabaseForTest(): Database {
  const db = getDatabase({ path: ':memory:' });
  dropAllTables(db);
  initializeSchema(db);
  return db;
}

/**
 * Transaction helper for wrapping multiple operations
 */
export function transaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn)();
}

// Re-export schema functions
export { initializeSchema, dropAllTables } from './schema';

// Re-export repository classes
export { WorkItemRepository } from './repositories/workItemRepository';
export { RepoCacheRepository } from './repositories/repoCacheRepository';
export { AgentRunRepository } from './repositories/agentRunRepository';
export { ReviewEventRepository } from './repositories/reviewEventRepository';
export { SyncEventRepository } from './repositories/syncEventRepository';
export { ServiceLeaseRepository } from './repositories/serviceLeaseRepository';
export { BotWatchSubscriptionRepository } from './repositories/botWatchSubscriptionRepository';
export { BotConversationPreferenceRepository } from './repositories/botConversationPreferenceRepository';
export { BotPendingActionRepository } from './repositories/botPendingActionRepository';
export { ShadowHarnessRepository } from './repositories/shadowHarnessRepository';
export { GovernanceAssessmentRepository } from './repositories/governanceAssessmentRepository';
export { GovernanceSuggestionRepository } from './repositories/governanceSuggestionRepository';
