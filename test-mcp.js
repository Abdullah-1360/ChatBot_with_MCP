/**
 * Test script for Plans MCP Server
 * Run with: node api/test-mcp.js
 */

const axios = require('axios');

const BASE_URL = process.env.MCP_URL || 'http://localhost:3002';

async function testMCPServer() {
  console.log('🧪 Testing Plans MCP Server...\n');
  console.log(`📡 Server URL: ${BASE_URL}\n`);

  try {
    // Test 1: Health Check
    console.log('1️⃣  Testing Health Check...');
    const health = await axios.get(`${BASE_URL}/health`);
    console.log('✅ Health:', health.data);
    console.log('');

    // Test 2: Search Plans
    console.log('2️⃣  Testing Search Plans (WordPress)...');
    const search = await axios.post(`${BASE_URL}/`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search_plans',
        arguments: {
          query: 'WordPress',
          currency: 'USD'
        }
      }
    });
    const searchResults = JSON.parse(search.data.result.content[0].text);
    console.log(`✅ Found ${searchResults.length} WordPress plans`);
    if (searchResults.length > 0) {
      console.log('   First result:', searchResults[0].name);
    }
    console.log('');

    // Test 3: Get Recommendations
    console.log('3️⃣  Testing Get Recommendations (Budget: $15)...');
    const recommend = await axios.post(`${BASE_URL}/`, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'get_recommendations',
        arguments: {
          budget: 15,
          currency: 'USD',
          requirements: ['wordpress'],
          billing_period: 'monthly'
        }
      }
    });
    const recommendations = JSON.parse(recommend.data.result.content[0].text);
    console.log(`✅ Got ${recommendations.length} recommendations`);
    if (recommendations.length > 0) {
      console.log('   Top recommendation:', recommendations[0].plan.name);
      console.log('   Score:', recommendations[0].score.toFixed(2));
    }
    console.log('');

    // Test 4: Get All Plans
    console.log('4️⃣  Testing Get All Plans...');
    const allPlans = await axios.post(`${BASE_URL}/`, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_all_plans',
        arguments: {
          currency: 'USD'
        }
      }
    });
    const plans = JSON.parse(allPlans.data.result.content[0].text);
    console.log(`✅ Total plans available: ${plans.length}`);
    console.log('');

    // Test 5: Get Logs
    console.log('5️⃣  Testing Logs Endpoint...');
    const logs = await axios.get(`${BASE_URL}/logs?format=summary`);
    console.log('✅ Log stats:', logs.data.stats);
    console.log('');

    console.log('🎉 All tests passed!\n');
    console.log('📋 Summary:');
    console.log(`   • Server is running: ✅`);
    console.log(`   • Plans loaded: ${plans.length}`);
    console.log(`   • Search working: ✅`);
    console.log(`   • Recommendations working: ✅`);
    console.log(`   • Logging working: ✅`);
    console.log('');
    console.log('✨ Your MCP server is ready to use with UChat!');
    console.log('');
    console.log('📖 Next steps:');
    console.log('   1. Deploy to Vercel or your server');
    console.log('   2. Configure UChat with the deployment URL');
    console.log('   3. Add AI agent instructions from UCHAT_AI_AGENT_INSTRUCTIONS.md');
    console.log('   4. Test with real queries in UChat');
    console.log('');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Response:', error.response.data);
    }
    console.log('');
    console.log('💡 Make sure the server is running:');
    console.log('   npm run mcp:api');
    process.exit(1);
  }
}

// Run tests
testMCPServer();
