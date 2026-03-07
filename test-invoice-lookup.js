/**
 * Test script for invoice lookup functionality
 * Run with: node test-invoice-lookup.js
 */

require('dotenv').config({ path: __dirname + '/.env' });

const { invoiceLookup } = require('./controllers/invoiceController');

async function testInvoiceLookup() {
  console.log('='.repeat(60));
  console.log('Testing Invoice Lookup');
  console.log('='.repeat(60));
  
  // Test cases
  const testCases = [
    {
      name: 'Test 1: Lookup by domain only',
      params: {
        domain: 'example.com' // Replace with a real domain from your WHMCS
      }
    },
    {
      name: 'Test 2: Lookup by email only',
      params: {
        email: 'test@example.com' // Replace with a real email from your WHMCS
      }
    },
    {
      name: 'Test 3: Lookup by invoice ID only',
      params: {
        invoiceId: '12345' // Replace with a real invoice ID from your WHMCS
      }
    },
    {
      name: 'Test 4: Lookup by domain + invoice ID',
      params: {
        domain: 'example.com', // Replace with a real domain
        invoiceId: '12345' // Replace with a real invoice ID
      }
    }
  ];
  
  for (const testCase of testCases) {
    console.log('\n' + '-'.repeat(60));
    console.log(testCase.name);
    console.log('-'.repeat(60));
    console.log('Parameters:', JSON.stringify(testCase.params, null, 2));
    console.log('\nExecuting...\n');
    
    const startTime = Date.now();
    
    try {
      const result = await invoiceLookup(testCase.params);
      const duration = Date.now() - startTime;
      
      console.log('\n' + '='.repeat(60));
      console.log('RESULT (took ' + duration + 'ms):');
      console.log('='.repeat(60));
      console.log(JSON.stringify(result, null, 2));
      
      if (result.success) {
        console.log('\n✅ SUCCESS');
      } else {
        console.log('\n❌ FAILED:', result.error);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      console.log('\n' + '='.repeat(60));
      console.log('ERROR (after ' + duration + 'ms):');
      console.log('='.repeat(60));
      console.log(error.message);
      console.log(error.stack);
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('All tests completed');
  console.log('='.repeat(60));
  
  process.exit(0);
}

// Run tests
testInvoiceLookup().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
