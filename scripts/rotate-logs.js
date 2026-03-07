#!/usr/bin/env node

/**
 * Log Rotation Script
 * Run daily via cron: 0 0 * * * node api/scripts/rotate-logs.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { rotateLogs, cleanupOldLogs } = require('../utils/performanceLogger');

console.log('='.repeat(60));
console.log('Log Rotation Script');
console.log('='.repeat(60));
console.log('Started at:', new Date().toISOString());

// Rotate logs
console.log('\n1. Rotating logs...');
rotateLogs();

// Cleanup old logs (keep last 7 days)
console.log('\n2. Cleaning up old logs...');
cleanupOldLogs(7);

console.log('\n' + '='.repeat(60));
console.log('Log rotation completed');
console.log('='.repeat(60));

process.exit(0);
