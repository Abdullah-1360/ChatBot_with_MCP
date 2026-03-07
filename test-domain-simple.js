/**
 * Simple test for domain availability check via MCP server
 * Prerequisites: MCP server must be running (npm run mcp)
 * Run: node test-domain-simple.js
 */

const axios = require('axios');

const MCP_SERVER_URL = 'http://localhost:3002';

async function testDomainCheck() {
  console.log('🧪 Testing Domain Availability Check via MCP Server\n');
  
  const testCases = [
    { domain: 'example.com', phone_number: null },
    { domain: 'google.com', phone_number: '+923001234567' },
    { domain: 'testdomain12345xyz.com', phone_number: null },
  ];
  
  for (const testCase of testCases) {
    console.log(`\n📋 Test: ${testCase.domain}`);
    console.log(`   Phone: ${testCase.phone_number || 'N/A'}`);
    console.log('   ---');
    
    try {
      const response = await axios.post(MCP_SERVER_URL, {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: 'check_domain_availability',
          arguments: testCase
        }
      });
      
      if (response.data.result) {
        const content = response.data.result.content[0].text;
        const data = JSON.parse(content);
        
        console.log(`   ✅ Success`);
        console.log(`   Available: ${data.available}`);
        console.log(`   Message: ${data.message}`);
        
        if (data.pricing) {
          console.log(`   Pricing: ${data.pricing.register} ${data.pricing.currency}`);
        }
        
        if (!data.available && data.suggestions) {
          console.log(`   Suggestions: ${data.suggestions.slice(0, 3).join(', ')}...`);
        }
      } else if (response.data.error) {
        console.log(`   ❌ Error: ${response.data.error.message}`);
      }
      
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        console.log(`   ❌ MCP Server not running. Start it with: npm run mcp`);
        break;
      } else {
        console.log(`   💥 Exception: ${error.message}`);
      }
    }
  }
  
  console.log('\n✅ Test complete\n');
}

// Run test
testDomainCheck().catch((error) => {
  console.error('💥 Test failed:', error.message);
  process.exit(1);
});
