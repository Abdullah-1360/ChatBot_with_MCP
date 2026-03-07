/**
 * Manual sync script for MCP Server
 * Syncs hosting plans from JSON to MongoDB
 */

require('dotenv').config();
const { connectDB } = require('../config/database');
const { syncPlansFromJSON } = require('../services/planSync');

async function main() {
    try {
        console.log('\n🚀 MCP Server: Plan Sync Script\n');
        
        // Connect to MongoDB
        await connectDB();
        
        // Sync plans
        const result = await syncPlansFromJSON();
        
        if (result.success) {
            console.log(`\n✅ Successfully synced ${result.totalInserted} plans to MongoDB`);
            console.log('\n📋 Summary:');
            result.byGID.forEach(({ gid, gidName, count }) => {
                console.log(`   ${gidName} (GID ${gid}): ${count} plans`);
            });
        } else {
            console.error(`\n❌ Sync failed: ${result.message}`);
            process.exit(1);
        }
        
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Fatal error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
