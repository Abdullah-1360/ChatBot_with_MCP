/**
 * Test script for domain availability check MCP tool
 * Run: node test-domain-check.js
 */

// Load environment variables from BOTH root and api folders
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({ path: __dirname + '/.env' });

const { connectDB } = require('./config/database');
const { getDomainAvailability } = require('../src/services/domainService');

async function testDomainCheck() {
  console.log('🧪 Testing Domain Availability Check\n');
  
  // Connect to MongoDB first
  console.log('🔄 Connecting to MongoDB...');
  try {
    await connectDB();
    console.log('✅ MongoDB connected\n');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    console.error('⚠️  Tests will use fallback TLD list\n');
  }
  
  const testCases = [
    { domain: 'example.com', phone: null },
    { domain: 'google.com', phone: '+923001234567' },
    { domain: 'hostbreak.pk', phone: '+923001234567' },
    { domain: 'invalid domain', phone: null }, // Should fail validation
  ];
  
  for (const testCase of testCases) {
    console.log(`\n📋 Test: ${testCase.domain}`);
    console.log(`   Phone: ${testCase.phone || 'N/A'}`);
    console.log('   ---');
    
    try {
      // Validate domain format (same as MCP tool)
      const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
      if (!domainRegex.test(testCase.domain)) {
        console.log('   ❌ Invalid domain format');
        continue;
      }
      
      const result = await getDomainAvailability(testCase.domain, testCase.phone);
      
      if (result.success) {
        console.log(`   ✅ Success`);
        console.log(`   Available: ${result.available}`);
        console.log(`   Message: ${result.message}`);
        
        if (result.pricing) {
          console.log(`   Pricing: ${result.pricing.register} ${result.pricing.currency}`);
        }
        
        if (!result.available && result.suggestions) {
          console.log(`   Suggestions: ${result.suggestions.slice(0, 3).join(', ')}...`);
        }
      } else {
        console.log(`   ❌ Error: ${result.error || result.message}`);
      }
      
    } catch (error) {
      console.log(`   💥 Exception: ${error.message}`);
    }
  }
  
  console.log('\n✅ Test complete\n');
  process.exit(0);
}

// Run test
testDomainCheck().catch((error) => {
  console.error('💥 Test failed:', error);
  process.exit(1);
});
