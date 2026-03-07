/**
 * Function Call Logger for Plans MCP Server
 * Tracks all function calls with timestamps and parameters
 */

const fs = require('fs');
const path = require('path');

class FunctionLogger {
    constructor() {
        this.logFile = path.join('/tmp', 'function-calls.log');
        this.initializeLogFile();
    }

    initializeLogFile() {
        try {
            // Create log file if it doesn't exist
            if (!fs.existsSync(this.logFile)) {
                const header = `=== Plans MCP Server Function Call Log ===\nStarted: ${new Date().toISOString()}\n\n`;
                fs.writeFileSync(this.logFile, header, 'utf8');
            }
        } catch (error) {
            console.error('Failed to initialize log file:', error.message);
        }
    }

    logFunctionCall(functionName, parameters = {}, result = null, error = null, duration = null) {
        try {
            const timestamp = new Date().toISOString();
            const logEntry = {
                timestamp,
                function: functionName,
                parameters,
                success: error === null,
                duration_ms: duration,
                result_summary: this.summarizeResult(result),
                error: error ? error.message : null
            };

            const logLine = `[${timestamp}] ${functionName}(${JSON.stringify(parameters)}) - ${error ? 'ERROR' : 'SUCCESS'}${duration ? ` (${duration}ms)` : ''}\n`;
            const detailedLog = `${JSON.stringify(logEntry, null, 2)}\n${'='.repeat(80)}\n`;

            // Append to log file
            fs.appendFileSync(this.logFile, logLine + detailedLog, 'utf8');
            
            // Also log to console for Vercel logs
            console.log(`📝 Function Log: ${logLine.trim()}`);
            
        } catch (logError) {
            console.error('Failed to write to log file:', logError.message);
        }
    }

    summarizeResult(result) {
        if (!result) return null;
        
        if (Array.isArray(result)) {
            return `Array with ${result.length} items`;
        }
        
        if (typeof result === 'object') {
            const keys = Object.keys(result);
            return `Object with keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}`;
        }
        
        return typeof result;
    }

    getLogContents() {
        try {
            if (fs.existsSync(this.logFile)) {
                return fs.readFileSync(this.logFile, 'utf8');
            }
            return 'Log file not found';
        } catch (error) {
            return `Error reading log file: ${error.message}`;
        }
    }

    clearLog() {
        try {
            this.initializeLogFile();
            return 'Log file cleared successfully';
        } catch (error) {
            return `Error clearing log file: ${error.message}`;
        }
    }

    getLogStats() {
        try {
            const logContent = this.getLogContents();
            const lines = logContent.split('\n').filter(line => line.includes('Function Log:'));
            
            const stats = {
                total_calls: lines.length,
                success_calls: lines.filter(line => line.includes('SUCCESS')).length,
                error_calls: lines.filter(line => line.includes('ERROR')).length,
                functions_called: [...new Set(lines.map(line => {
                    const match = line.match(/Function Log: \[.*?\] (\w+)\(/);
                    return match ? match[1] : null;
                }).filter(Boolean))],
                log_file_size: fs.existsSync(this.logFile) ? fs.statSync(this.logFile).size : 0,
                last_updated: fs.existsSync(this.logFile) ? fs.statSync(this.logFile).mtime.toISOString() : null
            };
            
            return stats;
        } catch (error) {
            return { error: error.message };
        }
    }
}

// Create singleton instance
const logger = new FunctionLogger();

// Wrapper function to automatically log function calls
function loggedFunction(functionName, originalFunction) {
    return async function(...args) {
        const startTime = Date.now();
        let result = null;
        let error = null;
        
        try {
            // Extract parameters from arguments
            const parameters = args.length > 0 ? args[0] : {};
            
            // Call original function
            result = await originalFunction.apply(this, args);
            
            // Log successful call
            const duration = Date.now() - startTime;
            logger.logFunctionCall(functionName, parameters, result, null, duration);
            
            return result;
        } catch (err) {
            error = err;
            const duration = Date.now() - startTime;
            logger.logFunctionCall(functionName, args[0] || {}, null, error, duration);
            throw err;
        }
    };
}

module.exports = {
    FunctionLogger,
    logger,
    loggedFunction
};