/**
 * Setup verification script
 * Checks if all required configuration is present
 */

require('dotenv').config({ path: __dirname + '/.env' });

console.log('='.repeat(60));
console.log('MCP Server Setup Verification');
console.log('='.repeat(60));

const checks = [];

// Check 1: Environment variables
console.log('\n1. Checking environment variables...');
const requiredEnvVars = [
  'WHMCS_URL',
  'WHMCS_IDENTIFIER',
  'WHMCS_SECRET',
  'MONGODB_URI'
];

requiredEnvVars.forEach(varName => {
  const value = process.env[varName];
  if (value) {
    console.log(`   ✅ ${varName}: ${varName.includes('SECRET') || varName.includes('URI') ? '[HIDDEN]' : value.substring(0, 30) + '...'}`);
    checks.push({ name: varName, status: 'ok' });
  } else {
    console.log(`   ❌ ${varName}: NOT SET`);
    checks.push({ name: varName, status: 'missing' });
  }
});

// Check 2: MongoDB connection
console.log('\n2. Checking MongoDB connection...');
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('   ✅ MongoDB connection successful');
    checks.push({ name: 'MongoDB', status: 'ok' });
    
    // Check 3: Hosting plans in database
    const HostingPlan = require('./models/HostingPlan');
    return HostingPlan.countDocuments();
  })
  .then(count => {
    console.log(`   ✅ Found ${count} hosting plans in database`);
    checks.push({ name: 'Hosting Plans', status: 'ok', count });
    
    // Check 4: WHMCS API connectivity
    console.log('\n3. Checking WHMCS API connectivity...');
    const { callApi } = require('./services/whmcsService');
    return callApi('GetInvoices', { limitnum: 1 });
  })
  .then(result => {
    console.log('   ✅ WHMCS API connection successful');
    checks.push({ name: 'WHMCS API', status: 'ok' });
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('Summary');
    console.log('='.repeat(60));
    
    const failed = checks.filter(c => c.status !== 'ok');
    if (failed.length === 0) {
      console.log('✅ All checks passed! Server is ready to start.');
      console.log('\nTo start the server, run:');
      console.log('   node server.js');
    } else {
      console.log('❌ Some checks failed:');
      failed.forEach(c => {
        console.log(`   - ${c.name}`);
      });
      console.log('\nPlease fix the issues above before starting the server.');
    }
    
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch(error => {
    console.log('   ❌ Error:', error.message);
    checks.push({ name: 'Connection Test', status: 'failed', error: error.message });
    
    console.log('\n' + '='.repeat(60));
    console.log('Setup verification failed');
    console.log('='.repeat(60));
    console.log('Error:', error.message);
    console.log('\nPlease check your configuration and try again.');
    
    process.exit(1);
  });
