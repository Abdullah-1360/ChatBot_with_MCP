/**
 * Plan Sync Service for MCP Server
 * Syncs hosting plans from JSON file to MongoDB
 */

const HostingPlan = require('../models/HostingPlan');
const fs = require('fs');
const path = require('path');

const log = (level, message) => {
    const timestamp = new Date().toISOString();
    const levelEmoji = {
        error: '🚨',
        warning: '⚠️',
        info: 'ℹ️',
        debug: '🐛'
    };
    console.log(`${timestamp} - ${levelEmoji[level]} ${level.toUpperCase()} - ${message}`);
};

/**
 * Transform JSON plan to MongoDB format (matches Product model schema)
 */
function transformPlan(jsonPlan) {
    return {
        pid: String(jsonPlan.pid),
        gid: String(jsonPlan.gid),
        name: jsonPlan.name || '',
        type: jsonPlan.type || 'hostingaccount',
        module: jsonPlan.module || '',
        paytype: jsonPlan.paymentType || jsonPlan.paytype || 'recurring',
        diskspace: String(jsonPlan.diskspace || '0'),
        freedomain: Boolean(jsonPlan.freeDomain || jsonPlan.freedomain),
        hidden: Boolean(jsonPlan.hidden),
        description: jsonPlan.description || '',
        pricing: jsonPlan.pricing || {},
        customfields: jsonPlan.customfields || null,
        configoptions: jsonPlan.configOptions || jsonPlan.configoptions || null,
        link: jsonPlan.link || `https://portal.hostbreak.com/cart.php?a=add&pid=${jsonPlan.pid}&currency=2`
    };
}

/**
 * Sync plans from JSON file to MongoDB
 */
async function syncPlansFromJSON() {
    try {
        log('info', '🔄 Starting plan sync from JSON to MongoDB...');
        
        // Load JSON file
        const dataPath = path.join(process.cwd(), 'api', 'all-plans-1763962201513.json');
        
        if (!fs.existsSync(dataPath)) {
            throw new Error(`Plans JSON file not found at: ${dataPath}`);
        }

        const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        const plans = data.plans || [];
        
        if (plans.length === 0) {
            log('warning', 'No plans found in JSON file');
            return { success: false, message: 'No plans found' };
        }

        log('info', `Found ${plans.length} plans in JSON file`);

        // Transform plans
        const transformed = plans.map(transformPlan);

        // Clear existing plans
        const deleteResult = await HostingPlan.deleteMany({});
        log('info', `🗑️  Deleted ${deleteResult.deletedCount} existing plans`);

        // Insert new plans
        const insertResult = await HostingPlan.insertMany(transformed);
        log('info', `✅ Inserted ${insertResult.length} plans`);

        // Display summary by GID
        const gids = [...new Set(plans.map(p => p.gid))];
        log('info', '📊 Plans by GID:');
        for (const gid of gids) {
            const count = plans.filter(p => p.gid === gid).length;
            const gidName = plans.find(p => p.gid === gid)?.gidName || 'Unknown';
            console.log(`   GID ${gid} (${gidName}): ${count} plans`);
        }

        return {
            success: true,
            totalInserted: insertResult.length,
            byGID: gids.map(gid => ({
                gid,
                gidName: plans.find(p => p.gid === gid)?.gidName || 'Unknown',
                count: plans.filter(p => p.gid === gid).length
            }))
        };

    } catch (error) {
        log('error', `Sync failed: ${error.message}`);
        throw error;
    }
}

/**
 * Get sync status
 */
async function getSyncStatus() {
    try {
        const count = await HostingPlan.countDocuments();
        const lastPlan = await HostingPlan.findOne().sort({ updatedAt: -1 });
        
        return {
            plansCount: count,
            lastSync: lastPlan?.updatedAt || null,
            status: count > 0 ? 'synced' : 'empty'
        };
    } catch (error) {
        log('error', `Failed to get sync status: ${error.message}`);
        return {
            plansCount: 0,
            lastSync: null,
            status: 'error',
            error: error.message
        };
    }
}

module.exports = {
    syncPlansFromJSON,
    getSyncStatus,
    transformPlan
};
