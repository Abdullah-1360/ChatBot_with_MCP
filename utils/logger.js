/**
 * Simple Logger Utility for MCP Server
 * Lightweight version for api folder
 */

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

class Logger {
  constructor(context = 'MCP') {
    this.context = context;
    this.level = process.env.LOG_LEVEL || 'INFO';
  }

  _shouldLog(level) {
    const currentLevel = LOG_LEVELS[this.level] || LOG_LEVELS.INFO;
    const messageLevel = LOG_LEVELS[level];
    return messageLevel <= currentLevel;
  }

  _formatMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    let logMessage = `[${timestamp}] [${level}] [${this.context}] ${message}`;
    
    if (data) {
      if (typeof data === 'object') {
        logMessage += ` ${JSON.stringify(data)}`;
      } else {
        logMessage += ` ${data}`;
      }
    }
    
    return logMessage;
  }

  error(message, data = null) {
    if (this._shouldLog('ERROR')) {
      console.error(this._formatMessage('ERROR', message, data));
    }
  }

  warn(message, data = null) {
    if (this._shouldLog('WARN')) {
      console.warn(this._formatMessage('WARN', message, data));
    }
  }

  info(message, data = null) {
    if (this._shouldLog('INFO')) {
      console.log(this._formatMessage('INFO', message, data));
    }
  }

  debug(message, data = null) {
    if (this._shouldLog('DEBUG')) {
      console.log(this._formatMessage('DEBUG', message, data));
    }
  }
}

function createLogger(context) {
  return new Logger(context);
}

module.exports = {
  Logger,
  createLogger,
  LOG_LEVELS
};
