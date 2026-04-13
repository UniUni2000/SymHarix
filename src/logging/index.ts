/**
 * Logging - Structured logging with issue/session context
 * Section 13: Logging, Status, and Observability
 */

/**
 * Log level enum
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

/**
 * Log entry structure
 */
export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
  error?: string;
}

/**
 * Logger options
 */
export interface LoggerOptions {
  level?: LogLevel;
  includeTimestamp?: boolean;
  includeContext?: boolean;
  jsonOutput?: boolean;
}

/**
 * Structured Logger
 * Section 13.1: Logging Conventions
 */
export class Logger {
  private level: LogLevel;
  private includeTimestamp: boolean;
  private includeContext: boolean;
  private jsonOutput: boolean;
  private defaultContext: Record<string, unknown> = {};

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? LogLevel.INFO;
    this.includeTimestamp = options.includeTimestamp ?? true;
    this.includeContext = options.includeContext ?? true;
    this.jsonOutput = options.jsonOutput ?? false;
  }

  /**
   * Set default context that will be included in all logs
   */
  setDefaultContext(context: Record<string, unknown>): void {
    this.defaultContext = { ...this.defaultContext, ...context };
  }

  /**
   * Create a child logger with additional context
   */
  child(context: Record<string, unknown>): Logger {
    const childLogger = new Logger({
      level: this.level,
      includeTimestamp: this.includeTimestamp,
      includeContext: this.includeContext,
      jsonOutput: this.jsonOutput
    });
    childLogger.defaultContext = { ...this.defaultContext, ...context };
    return childLogger;
  }

  /**
   * Format a log entry
   */
  private formatEntry(level: string, message: string, context?: Record<string, unknown>, error?: Error): string {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message
    };

    // Include context if enabled
    const fullContext = { ...this.defaultContext, ...context };
    if (this.includeContext && Object.keys(fullContext).length > 0) {
      entry.context = fullContext;
    }

    // Include error if present
    if (error) {
      entry.error = error.message;
    }

    if (this.jsonOutput) {
      return JSON.stringify(entry);
    } else {
      const parts: string[] = [];
      if (this.includeTimestamp) {
        parts.push(`[${entry.timestamp}]`);
      }
      parts.push(`[${level}]`);
      parts.push(entry.message);

      if (Object.keys(fullContext).length > 0) {
        const contextStr = Object.entries(fullContext)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        parts.push(contextStr);
      }

      if (error) {
        parts.push(`error=${error.message}`);
      }

      return parts.join(' ');
    }
  }

  /**
   * Output a log line
   */
  private output(level: string, message: string, context?: Record<string, unknown>, error?: Error): void {
    const formatted = this.formatEntry(level, message, context, error);

    switch (level) {
      case 'DEBUG':
      case 'INFO':
        console.log(formatted);
        break;
      case 'WARN':
        console.warn(formatted);
        break;
      case 'ERROR':
        console.error(formatted);
        break;
    }
  }

  /**
   * Log at DEBUG level
   */
  debug(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.DEBUG) {
      this.output('DEBUG', message, context);
    }
  }

  /**
   * Log at INFO level
   */
  info(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.INFO) {
      this.output('INFO', message, context);
    }
  }

  /**
   * Log at WARN level
   */
  warn(message: string, context?: Record<string, unknown>, error?: Error): void {
    if (this.level <= LogLevel.WARN) {
      this.output('WARN', message, context, error);
    }
  }

  /**
   * Log at ERROR level
   */
  error(message: string, context?: Record<string, unknown>, error?: Error): void {
    if (this.level <= LogLevel.ERROR) {
      this.output('ERROR', message, context, error);
    }
  }

  /**
   * Log with issue context
   * Section 13.1: Required context fields include issue_id, issue_identifier
   */
  logWithIssue(issueId: string, issueIdentifier: string, message: string, context?: Record<string, unknown>): void {
    this.info(message, {
      issue_id: issueId,
      issue_identifier: issueIdentifier,
      ...context
    });
  }

  /**
   * Log with session context
   * Section 13.1: Required context for session lifecycle logs includes session_id
   */
  logWithSession(sessionId: string, message: string, context?: Record<string, unknown>): void {
    this.info(message, {
      session_id: sessionId,
      ...context
    });
  }
}

/**
 * Default logger instance
 */
export const logger = new Logger();

/**
 * Create an issue-scoped logger
 */
export function createIssueLogger(issueId: string, issueIdentifier: string): Logger {
  return logger.child({
    issue_id: issueId,
    issue_identifier: issueIdentifier
  });
}

/**
 * Create a session-scoped logger
 */
export function createSessionLogger(sessionId: string): Logger {
  return logger.child({
    session_id: sessionId
  });
}
