/**
 * Non-blocking Performance Logger
 * Writes logs asynchronously without affecting response times
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const appendFile = promisify(fs.appendFile);

// Log directory
const LOG_DIR = path.join(__dirname, '../logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Log file paths
const PERFORMANCE_LOG = path.join(LOG_DIR, 'performance.log');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');
const METRICS_LOG = path.join(LOG_DIR, 'metrics.log');

// Log queue for batch writing
const logQueue = [];
let flushTimer = null;
const FLUSH_INTERVAL = 1000; // Flush every 1 second
const MAX_QUEUE_SIZE = 100; // Flush if queue reaches this size

/**
 * Format log entry
 */
function formatLogEntry(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const dataStr = Object.keys(data).length > 0 ? ` | ${JSON.stringify(data)}` : '';
  return `[${timestamp}] [${level}] ${message}${dataStr}\n`;
}

/**
 * Flush logs to file (non-blocking)
 */
async function flushLogs() {
  if (logQueue.length === 0) return;
  
  // Get all queued logs
  const logsToWrite = [...logQueue];
  logQueue.length = 0; // Clear queue
  
  // Group logs by file
  const logsByFile = {
    [PERFORMANCE_LOG]: [],
    [ERROR_LOG]: [],
    [METRICS_LOG]: []
  };
  
  logsToWrite.forEach(({ file, entry }) => {
    if (logsByFile[file]) {
      logsByFile[file].push(entry);
    }
  });
  
  // Write to files asynchronously (don't await)
  Object.entries(logsByFile).forEach(([file, entries]) => {
    if (entries.length > 0) {
      appendFile(file, entries.join('')).catch(err => {
        console.error('[PerformanceLogger] Write error:', err.message);
      });
    }
  });
}

/**
 * Schedule flush
 */
function scheduleFlush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushLogs();
    flushTimer = null;
  }, FLUSH_INTERVAL);
}

/**
 * Add log to queue (non-blocking)
 */
function queueLog(file, level, message, data = {}) {
  const entry = formatLogEntry(level, message, data);
  logQueue.push({ file, entry });
  
  // Flush immediately if queue is full
  if (logQueue.length >= MAX_QUEUE_SIZE) {
    setImmediate(() => flushLogs());
  } else {
    scheduleFlush();
  }
}

/**
 * Log performance metrics
 */
function logPerformance(tool, duration, success, metadata = {}) {
  queueLog(PERFORMANCE_LOG, 'PERF', `${tool}`, {
    duration_ms: duration,
    success,
    ...metadata
  });
}

/**
 * Log errors
 */
function logError(tool, error, metadata = {}) {
  queueLog(ERROR_LOG, 'ERROR', `${tool}: ${error}`, metadata);
}

/**
 * Log metrics (for analytics)
 */
function logMetric(metric, value, metadata = {}) {
  queueLog(METRICS_LOG, 'METRIC', metric, {
    value,
    ...metadata
  });
}

/**
 * Get log statistics
 */
function getLogStats() {
  const stats = {};
  
  [PERFORMANCE_LOG, ERROR_LOG, METRICS_LOG].forEach(file => {
    try {
      const stat = fs.statSync(file);
      const filename = path.basename(file);
      stats[filename] = {
        size: stat.size,
        size_mb: (stat.size / 1024 / 1024).toFixed(2),
        modified: stat.mtime
      };
    } catch (err) {
      // File doesn't exist yet
    }
  });
  
  return {
    stats,
    queue_size: logQueue.length,
    log_directory: LOG_DIR
  };
}

/**
 * Rotate logs (call this daily via cron)
 */
function rotateLogs() {
  const date = new Date().toISOString().split('T')[0];
  
  [PERFORMANCE_LOG, ERROR_LOG, METRICS_LOG].forEach(file => {
    if (fs.existsSync(file)) {
      const ext = path.extname(file);
      const base = path.basename(file, ext);
      const archived = path.join(LOG_DIR, `${base}-${date}${ext}`);
      
      try {
        fs.renameSync(file, archived);
        console.log(`[PerformanceLogger] Rotated ${path.basename(file)} to ${path.basename(archived)}`);
      } catch (err) {
        console.error(`[PerformanceLogger] Rotation error:`, err.message);
      }
    }
  });
}

/**
 * Clean up old logs (keep last 7 days)
 */
function cleanupOldLogs(daysToKeep = 7) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  
  try {
    const files = fs.readdirSync(LOG_DIR);
    let deletedCount = 0;
    
    files.forEach(file => {
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      
      if (stat.mtime < cutoffDate) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    });
    
    if (deletedCount > 0) {
      console.log(`[PerformanceLogger] Cleaned up ${deletedCount} old log files`);
    }
  } catch (err) {
    console.error('[PerformanceLogger] Cleanup error:', err.message);
  }
}

/**
 * Graceful shutdown - flush remaining logs
 */
function shutdown() {
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushLogs();
}

// Handle process termination
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);

module.exports = {
  logPerformance,
  logError,
  logMetric,
  getLogStats,
  rotateLogs,
  cleanupOldLogs,
  flushLogs
};
