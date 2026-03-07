/**
 * Production-Grade MCP Server for Hosting Plans
 * Uses MongoDB for data storage
 * SSE Mode - Node.js
 */

const express = require('express');
const cors = require('cors');
const { logger } = require('../logger');
const { connectDB } = require('../config/database');
const HostingPlan = require('../models/HostingPlan');

// Configure logging for Vercel
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

class PlansManager {
    constructor() {
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        try {
            await connectDB();
            const count = await HostingPlan.countDocuments();
            log('info', `Initialized with ${count} plans from MongoDB`);
            this.initialized = true;
        } catch (error) {
            log('error', `Failed to initialize: ${error.message}`);
            throw error;
        }
    }

    async getAllPlans(currency = "USD") {
        await this.initialize();
        const plans = await HostingPlan.find({ hidden: false }).lean();
        return plans.map(plan => this._formatPlanEnhanced(plan, currency));
    }

    async getPlanById(planId, currency = "USD") {
        await this.initialize();
        const plan = await HostingPlan.findOne({ pid: planId, hidden: false }).lean();
        return plan ? this._formatPlanEnhanced(plan, currency) : null;
    }

    async searchPlans(query, currency = "USD", maxBudget = 999999, minStorage = 0, limit = 5) {
        await this.initialize();
        
        const queryLower = query.toLowerCase().trim();
        const normalizedQuery = queryLower.replace(/[\s\-_]/g, '');

        // Build MongoDB query
        const mongoQuery = { hidden: false };

        // Budget filter
        if (maxBudget < 999999) {
            mongoQuery[`pricing.${currency}.monthly`] = { $lte: String(maxBudget) };
        }

        // Storage filter
        if (minStorage > 0) {
            mongoQuery.diskspace = { $gte: String(minStorage) };
        }

        // Fetch plans from MongoDB
        const plans = await HostingPlan.find(mongoQuery).lean();

        const results = [];

        plans.forEach(plan => {
            let score = 0;

            if (query) {
                const planNameLower = plan.name.toLowerCase();
                const normalizedPlanName = planNameLower.replace(/[\s\-_]/g, '');
                const descLower = plan.description.toLowerCase();

                // Exact match (with normalization)
                if (normalizedPlanName === normalizedQuery || planNameLower === queryLower) {
                    score += 100;
                }
                // Plan name contains query (normalized)
                else if (normalizedPlanName.includes(normalizedQuery)) {
                    score += 80;
                }
                // Plan name contains query (original)
                else if (planNameLower.includes(queryLower)) {
                    score += 70;
                }
                // Query words all appear in plan name
                else {
                    const queryWords = queryLower.split(/[\s\-_]+/);
                    const matchedWords = queryWords.filter(word => 
                        word.length > 0 && planNameLower.includes(word)
                    );
                    if (matchedWords.length === queryWords.length) {
                        score += 60;
                    } else if (matchedWords.length > 0) {
                        score += 30 * (matchedWords.length / queryWords.length);
                    }
                }

                // Description match
                if (descLower.includes(queryLower)) {
                    score += 25;
                } else {
                    const queryWords = queryLower.split(/[\s\-_]+/);
                    const matchedWords = queryWords.filter(word => 
                        word.length > 0 && descLower.includes(word)
                    );
                    if (matchedWords.length > 0) {
                        score += 15 * (matchedWords.length / queryWords.length);
                    }
                }

                // Config options match
                if (plan.configOptions) {
                    const configStr = JSON.stringify(plan.configOptions).toLowerCase();
                    if (configStr.includes(queryLower)) {
                        score += 10;
                    }
                }
            } else {
                score = 10;
            }

            // Boost score for better value
            if (maxBudget < 999999) {
                const monthlyPrice = parseFloat(plan.pricing[currency]?.monthly || "999999");
                const valueScore = ((maxBudget - monthlyPrice) / maxBudget) * 15;
                score += valueScore;
            }

            if (score > 0) {
                results.push({
                    plan: this._formatPlanEnhanced(plan, currency),
                    relevance_score: Math.round(score)
                });
            }
        });

        results.sort((a, b) => b.relevance_score - a.relevance_score);
        return results.slice(0, limit);
    }

    getRecommendations(budget, currency = "USD", requirements = [], billingPeriod = "monthly", minStorage = null) {
        const candidates = [];

        this.plans.forEach(plan => {
            const priceStr = plan.pricing[currency]?.[billingPeriod] || "0";
            const price = parseFloat(priceStr);

            if (price > budget) {
                return;
            }

            if (minStorage && parseInt(plan.diskspace) < minStorage) {
                return;
            }

            if (requirements.length > 0) {
                const planStr = `${plan.name} ${plan.description} ${JSON.stringify(plan.configOptions || {})}`.toLowerCase();
                if (!requirements.every(req => planStr.includes(req.toLowerCase()))) {
                    return;
                }
            }

            const valueScore = budget > 0 ? (budget - price) / budget : 0;
            const featureCount = this._countFeatures(plan);
            const storageScore = minStorage ? Math.min(parseInt(plan.diskspace) / minStorage, 2) : 1;
            
            const finalScore = (storageScore * 0.4) + (valueScore * 0.3) + ((featureCount / 20) * 0.3);

            candidates.push({
                plan: this._formatPlan(plan, currency),
                score: finalScore,
                value_for_money: valueScore,
                feature_count: featureCount,
                storage_score: storageScore,
                meets_storage: !minStorage || parseInt(plan.diskspace) >= minStorage
            });
        });

        candidates.sort((a, b) => b.score - a.score);
        return candidates.slice(0, 5);
    }

    comparePlans(planIds, currency = "USD") {
        const plans = planIds.map(pid => this.plansIndex[pid]).filter(Boolean);

        if (plans.length === 0) {
            return { error: "No valid plans found" };
        }

        return {
            plans: plans.map(p => this._formatPlan(p, currency)),
            comparison_table: {
                diskspace: plans.map(p => ({
                    plan_id: p.pid,
                    plan_name: p.name,
                    diskspace: p.diskspace
                })),
                pricing: plans.map(p => ({
                    plan_id: p.pid,
                    plan_name: p.name,
                    monthly: p.pricing[currency]?.monthly,
                    annually: p.pricing[currency]?.annually
                })),
                features: this._extractCommonFeatures(plans)
            }
        };
    }

    getPlanDetails(planId, currency = "USD") {
        const plan = this.plansIndex[planId];
        if (!plan) {
            return null;
        }

        return {
            ...this._formatPlan(plan, currency),
            config_options: this._parseConfigOptions(plan.configOptions),
            all_pricing: plan.pricing,
            features: this._extractFeatures(plan)
        };
    }

    _formatPlanEnhanced(plan, currency) {
        const monthlyPrice = plan.pricing[currency]?.monthly || "N/A";
        const annualPrice = plan.pricing[currency]?.annually || "N/A";
        
        return {
            id: plan.pid,
            name: plan.name,
            group: plan.gidName,
            description: plan.description,
            diskspace: plan.diskspace,
            free_domain: plan.freeDomain,
            monthly_price: monthlyPrice,
            annual_price: annualPrice,
            currency: currency,
            order_link: plan.link,
            key_features: this._extractKeyFeatures(plan)
        };
    }

    _extractKeyFeatures(plan) {
        const features = [];
        const desc = plan.description.toLowerCase();
        
        // Extract key features from description
        if (desc.includes('wordpress')) features.push('WordPress');
        if (desc.includes('ssl')) features.push('Free SSL');
        if (desc.includes('backup')) features.push('Backups');
        if (desc.includes('email')) features.push('Email');
        if (desc.includes('cpanel')) features.push('cPanel');
        if (desc.includes('nvme')) features.push('NVMe Storage');
        if (desc.includes('ssd')) features.push('SSD Storage');
        
        // Add storage
        features.push(`${plan.diskspace} Storage`);
        
        return features.slice(0, 5); // Limit to 5 key features
    }

    _formatPlan(plan, currency) {
        return {
            id: plan.pid,
            name: plan.name,
            group: plan.gidName,
            description: plan.description,
            diskspace: plan.diskspace,
            free_domain: plan.freeDomain,
            pricing: {
                currency: currency,
                monthly: plan.pricing[currency]?.monthly,
                quarterly: plan.pricing[currency]?.quarterly,
                semiannually: plan.pricing[currency]?.semiannually,
                annually: plan.pricing[currency]?.annually,
                biennially: plan.pricing[currency]?.biennially,
                triennially: plan.pricing[currency]?.triennially
            },
            order_link: plan.link
        };
    }

    _parseConfigOptions(configOptions) {
        if (!configOptions || !configOptions.configoption) {
            return [];
        }

        return configOptions.configoption.map(opt => ({
            id: opt.id,
            name: opt.name,
            options: (opt.options?.option || []).map(o => ({
                id: o.id,
                name: o.name
            }))
        }));
    }

    _extractFeatures(plan) {
        const features = new Set();

        plan.description.split(',').forEach(part => {
            const trimmed = part.trim();
            if (trimmed) {
                features.add(trimmed);
            }
        });

        if (plan.configOptions?.configoption) {
            plan.configOptions.configoption.forEach(opt => {
                features.add(opt.name || "");
                (opt.options?.option || []).forEach(o => {
                    features.add(o.name || "");
                });
            });
        }

        return Array.from(features);
    }

    _extractCommonFeatures(plans) {
        const allFeatures = plans.map(p => this._extractFeatures(p));

        if (allFeatures.length === 0) {
            return { all_features: [], common_features: [] };
        }

        const common = new Set(allFeatures[0]);
        allFeatures.slice(1).forEach(features => {
            const featureSet = new Set(features);
            common.forEach(feature => {
                if (!featureSet.has(feature)) {
                    common.delete(feature);
                }
            });
        });

        return {
            all_features: allFeatures,
            common_features: Array.from(common)
        };
    }

    _countFeatures(plan) {
        return this._extractFeatures(plan).length;
    }
}

// Initialize plans manager (singleton for Vercel)
let plansManager;
const getPlansManager = () => {
    if (!plansManager) {
        plansManager = new PlansManager();
    }
    return plansManager;
};

// MCP Tools definitions - OPTIMIZED FOR SINGLE CALL
const MCP_TOOLS = [
    {
        name: "search_plans",
        description: "MAIN TOOL: Search and recommend plans in ONE call. Use for ANY plan query - searches by keyword, filters by budget, returns top 5 matches with full details. DO NOT call other tools after this.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search keyword (e.g., 'WordPress', 'SSL', 'business hosting')",
                    default: ""
                },
                max_budget: {
                    type: "number",
                    description: "Maximum budget filter (e.g., 15 for $15/month). Optional.",
                    default: 999999
                },
                currency: {
                    type: "string",
                    description: "Currency: 'USD' or 'PKR'",
                    enum: ["USD", "PKR"],
                    default: "USD"
                },
                min_storage: {
                    type: "number",
                    description: "Minimum storage in GB. Optional.",
                    default: 0
                },
                limit: {
                    type: "number",
                    description: "Max results to return (1-10)",
                    default: 5,
                    minimum: 1,
                    maximum: 10
                }
            }
        }
    },
    {
        name: "get_plan_by_id",
        description: "ONLY use if you already have a specific plan ID from previous response. Returns single plan details.",
        inputSchema: {
            type: "object",
            properties: {
                plan_id: {
                    type: "string",
                    description: "Plan ID from previous search"
                },
                currency: {
                    type: "string",
                    enum: ["USD", "PKR"],
                    default: "USD"
                }
            },
            required: ["plan_id"]
        }
    },
    {
        name: "compare_plans",
        description: "ONLY use when user explicitly asks to compare 2-3 specific plans by ID. Requires plan IDs from previous search.",
        inputSchema: {
            type: "object",
            properties: {
                plan_ids: {
                    type: "array",
                    items: { type: "string" },
                    description: "2-3 plan IDs to compare",
                    minItems: 2,
                    maxItems: 3
                },
                currency: {
                    type: "string",
                    enum: ["USD", "PKR"],
                    default: "USD"
                }
            },
            required: ["plan_ids"]
        }
    }
];

// Execute tool function
async function executeTool(name, args) {
    const startTime = Date.now();
    log('info', `🔧 Tool called: ${name}`);
    
    try {
        const manager = getPlansManager();
        let result;
        
        switch (name) {
            case "search_plans":
                const query = args.query || "";
                const currency = args.currency || "USD";
                const maxBudget = args.max_budget || 999999;
                const minStorage = args.min_storage || 0;
                const limit = Math.min(args.limit || 5, 10);
                
                const searchResults = manager.searchPlans(query, currency, maxBudget, minStorage, limit);
                
                if (searchResults.length === 0) {
                    return {
                        success: true,
                        data: [],
                        count: 0,
                        message: `No plans found matching "${query}". Try: "WordPress", "business", "SSL", or browse all plans with an empty search.`,
                        suggestions: [
                            "Try searching for: WordPress, business, SSL, reseller",
                            "Remove budget/storage filters if set",
                            "Search with empty query to see all plans"
                        ]
                    };
                }
                
                return { 
                    success: true, 
                    data: searchResults,
                    count: searchResults.length,
                    message: `Found ${searchResults.length} plans matching your criteria`
                };

            case "get_plan_by_id":
                const planId = args.plan_id;
                const currency1 = args.currency || "USD";
                const result1 = manager.getPlanDetails(planId, currency1);
                if (!result1) {
                    return { success: false, error: `Plan ${planId} not found` };
                }
                return { success: true, data: result1 };

            case "compare_plans":
                const planIds = args.plan_ids || [];
                if (planIds.length < 2 || planIds.length > 3) {
                    return { success: false, error: "Please provide 2-3 plan IDs to compare" };
                }
                const currency4 = args.currency || "USD";
                const result4 = manager.comparePlans(planIds, currency4);
                if (result4.error) {
                    return { success: false, error: result4.error };
                }
                return { success: true, data: result4 };

            default:
                return { success: false, error: `Unknown tool: ${name}` };
        }
    } catch (error) {
        const duration = Date.now() - startTime;
        log('error', `💥 Error executing tool ${name} after ${duration}ms: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Create Express app
const app = express();

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['*'],
    credentials: true
}));

app.use(express.json());

// SSE endpoint
app.get('/sse', (req, res) => {
    logger.logFunctionCall('sse_connection', { client_ip: req.ip, user_agent: req.get('User-Agent') });
    log('info', '🌊 SSE connection established');

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });

    res.write('event: connect\n');
    res.write(`data: ${JSON.stringify({ status: 'connected', server: 'plans-mcp-server-vercel' })}\n\n`);

    const capabilities = {
        jsonrpc: "2.0",
        id: "init",
        result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
                name: "plans-mcp-server-vercel",
                version: "1.0.0"
            }
        }
    };
    res.write('event: initialize\n');
    res.write(`data: ${JSON.stringify(capabilities)}\n\n`);

    const toolsList = {
        jsonrpc: "2.0",
        id: "tools",
        result: { tools: MCP_TOOLS }
    };
    res.write('event: tools\n');
    res.write(`data: ${JSON.stringify(toolsList)}\n\n`);

    req.on('close', () => {
        logger.logFunctionCall('sse_disconnect', { client_ip: req.ip });
        log('info', '🔌 SSE connection closed');
    });
});

// Root endpoints
app.get('/', (req, res) => {
    logger.logFunctionCall('root_endpoint', { method: 'GET', client_ip: req.ip });
    const manager = getPlansManager();
    res.json({
        name: "Plans MCP Server - Vercel Deployment",
        version: "1.0.0",
        description: "MCP Server with SSE transport for uChat integration on Vercel",
        plans_loaded: manager.plans.length,
        tools_available: MCP_TOOLS.length,
        endpoints: {
            health: "/health",
            sse: "/sse",
            logs: "/logs"
        }
    });
});

app.post('/', async (req, res) => {
    const { method, id, params } = req.body;
    logger.logFunctionCall('jsonrpc_request', { method, id, params: Object.keys(params || {}) });
    
    try {
        switch (method) {
            case "initialize":
                res.json({
                    jsonrpc: "2.0",
                    id: id,
                    result: {
                        protocolVersion: "2024-11-05",
                        capabilities: { tools: {} },
                        serverInfo: {
                            name: "plans-mcp-server-vercel",
                            version: "1.0.0"
                        }
                    }
                });
                break;

            case "tools/list":
                res.json({
                    jsonrpc: "2.0",
                    id: id,
                    result: { tools: MCP_TOOLS }
                });
                break;

            case "tools/call":
                const toolName = params?.name;
                const toolArgs = params?.arguments || {};

                if (!toolName) {
                    return res.json({
                        jsonrpc: "2.0",
                        id: id,
                        error: {
                            code: -32602,
                            message: "Invalid params: tool name is required"
                        }
                    });
                }

                const result = await executeTool(toolName, toolArgs);

                if (result.success) {
                    res.json({
                        jsonrpc: "2.0",
                        id: id,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(result.data, null, 2)
                                }
                            ]
                        }
                    });
                } else {
                    res.json({
                        jsonrpc: "2.0",
                        id: id,
                        error: {
                            code: -32603,
                            message: result.error || "Unknown error"
                        }
                    });
                }
                break;

            default:
                res.json({
                    jsonrpc: "2.0",
                    id: id,
                    error: {
                        code: -32601,
                        message: `Method not found: ${method}`
                    }
                });
        }
    } catch (error) {
        res.json({
            jsonrpc: "2.0",
            id: req.body?.id || null,
            error: {
                code: -32603,
                message: error.message
            }
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    logger.logFunctionCall('health_check', { client_ip: req.ip });
    const manager = getPlansManager();
    res.json({
        status: "healthy",
        server: "Plans MCP Server - Vercel",
        plans_loaded: manager.plans.length,
        tools_available: MCP_TOOLS.length,
        timestamp: new Date().toISOString()
    });
});

// Logs endpoint
app.get('/logs', (req, res) => {
    logger.logFunctionCall('logs_endpoint', { client_ip: req.ip, format: req.query.format });
    const format = req.query.format || 'summary';
    
    if (format === 'full') {
        const logs = logger.getLogContents();
        res.json({
            format: 'full',
            logs: logs,
            timestamp: new Date().toISOString()
        });
    } else {
        const stats = logger.getLogStats();
        res.json({
            format: 'summary',
            stats: stats,
            timestamp: new Date().toISOString()
        });
    }
});

// Export for Vercel
module.exports = app;