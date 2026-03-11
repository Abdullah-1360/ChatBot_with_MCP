/**
 * Production-Grade MCP Server for Hosting Plans
 * Uses MongoDB for data storage and reuses existing recommendation services
 * SSE Mode - Node.js
 */

// Load environment variables from BOTH api/.env and root .env
// Load root .env first (for src/ services), then api/.env (for overrides)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const { logger } = require('./logger');
const { connectDB } = require('./config/database');
const HostingPlan = require('./models/HostingPlan');
const { logPerformance, logError, logMetric } = require('./utils/performanceLogger');

// Import services from local api folder (reuse business logic)
const planMatcher = require('./services/planMatcher');
const { calculateConfidence } = require('./services/confidenceScorer');
const { findNearestNeighbors } = require('./services/nearestNeighbor');
const { filterPlansByRequirements } = require('./services/requirementsAnalyzer');
const { getTierFromPlan, getTierRank } = require('./utils/tierHelper');

// MongoDB-based WHMCS service replacement
const mongoWhmcs = {
    async getProductsByGid(gid) {
        const plans = await HostingPlan.find({ gid: String(gid), hidden: false }).lean();
        return plans;
    }
};

// Configure logging
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
            // Check if already connected (from server startup)
            const mongoose = require('mongoose');
            if (mongoose.connection.readyState === 1) {
                // Already connected
                this.initialized = true;
                return;
            }
            
            // Connect if not already connected
            await connectDB();
            const count = await HostingPlan.countDocuments();
            log('info', `Initialized with ${count} plans from MongoDB`);
            this.initialized = true;
        } catch (error) {
            log('error', `Failed to initialize: ${error.message}`);
            throw error;
        }
    }

    /**
     * Intelligent recommendation using existing recommendation controller logic
     * Reuses: planMatcher, confidenceScorer, nearestNeighbor, requirementsAnalyzer
     */
    async recommendPlans(requirements) {
        await this.initialize();
        
        const {
            purpose = 'Other',
            websites_count = null,
            storage_needed_gb = 10,
            monthly_budget = 0,
            free_domain = false,
            needs_ssl = false,
            needs_reseller = false,
            needs_windows = false,
            other_requirements = '',
            currency = 'USD'
        } = requirements;

        // Prepare answers object for planMatcher (same format as REST endpoint)
        const answers = {
            purpose,
            websites_count,
            storage_needed_gb,
            free_domain,
            needs_reseller,
            needs_ssl,
            needs_windows,
            other_requirements
        };

        // Use existing planMatcher to determine GID and tier
        const { gid, minTier, reasoning } = planMatcher(answers);
        
        log('info', `Plan matcher: GID=${gid}, minTier=${minTier}, reasoning=${reasoning}`);

        // Fetch products for determined group (from MongoDB, not WHMCS API)
        let allPlans = await mongoWhmcs.getProductsByGid(gid);
        
        // Filter based on Windows requirement (same logic as controller)
        if (answers.needs_windows === true) {
            const windowsPlans = allPlans.filter(p => {
                if (!p.name) return false;
                return p.name.toLowerCase().includes('windows');
            });
            
            if (windowsPlans.length > 0) {
                allPlans = windowsPlans;
            } else {
                // Search all hosting GIDs for Windows plans (from MongoDB)
                const hostingGids = [1, 20, 21, 25, 28];
                const allGidPlans = await Promise.all(
                    hostingGids.map(gidNum => mongoWhmcs.getProductsByGid(gidNum))
                );
                const allWindowsPlans = allGidPlans.flat().filter(p => {
                    if (!p.name) return false;
                    return p.name.toLowerCase().includes('windows');
                });
                
                if (allWindowsPlans.length > 0) {
                    allPlans = allWindowsPlans;
                } else {
                    return {
                        plans: [],
                        message: 'No Windows hosting plans found',
                        reasoning
                    };
                }
            }
        } else {
            // Filter out Windows plans (default behavior)
            const nonWindowsPlans = allPlans.filter(p => {
                if (!p.name) return true;
                return !p.name.toLowerCase().includes('windows');
            });
            
            if (nonWindowsPlans.length > 0) {
                allPlans = nonWindowsPlans;
            }
        }
        
        // Filter out hidden plans
        const hiddenPids = [238, 250];
        allPlans = allPlans.filter(p => !hiddenPids.includes(parseInt(p.pid)));
        
        if (!allPlans.length) {
            return {
                plans: [],
                message: `No plans found for GID ${gid}`,
                reasoning
            };
        }

        // Storage filtering with flexible thresholds (same logic as controller)
        let storageMatches = allPlans.filter(p => {
            const diskspace = p.diskspace;
            if (diskspace === 'unlimited' || diskspace === 'Unlimited') return true;
            return parseInt(diskspace) >= storage_needed_gb;
        });
        
        if (storageMatches.length < 3) {
            const threshold = Math.max(5, storage_needed_gb * 0.6);
            const fallbackMatches = allPlans.filter(p => {
                const diskspace = p.diskspace;
                if (diskspace === 'unlimited' || diskspace === 'Unlimited') return true;
                return parseInt(diskspace) >= threshold;
            });
            
            if (fallbackMatches.length > storageMatches.length) {
                storageMatches = fallbackMatches;
            }
            
            if (storageMatches.length < 3) {
                const minThreshold = Math.max(5, storage_needed_gb * 0.4);
                const minMatches = allPlans.filter(p => {
                    const diskspace = p.diskspace;
                    if (diskspace === 'unlimited' || diskspace === 'Unlimited') return true;
                    return parseInt(diskspace) >= minThreshold;
                });
                
                if (minMatches.length > storageMatches.length) {
                    storageMatches = minMatches;
                }
            }
            
            if (storageMatches.length === 0) {
                storageMatches = allPlans;
            }
        }

        // Filter by tier from websites_count (using existing tierHelper)
        let exactMatches;
        
        if (websites_count === null) {
            exactMatches = storageMatches;
        } else {
            let tierMatches = storageMatches.filter(p => 
                getTierRank(getTierFromPlan(p)) >= getTierRank(minTier)
            );
            
            exactMatches = tierMatches;
            if (tierMatches.length < 3) {
                const lowerTierRank = getTierRank(minTier) - 1;
                if (lowerTierRank >= 0) {
                    const flexibleMatches = storageMatches.filter(p => 
                        getTierRank(getTierFromPlan(p)) >= lowerTierRank
                    );
                    if (flexibleMatches.length > tierMatches.length) {
                        exactMatches = flexibleMatches;
                    }
                }
                
                if (exactMatches.length < 3) {
                    exactMatches = storageMatches;
                }
            }
        }

        // Filter by free domain if requested
        if (free_domain) {
            const withDomain = exactMatches.filter(p => p.freedomain);
            if (withDomain.length >= 1) {
                exactMatches = withDomain;
            }
        }

        // Apply other_requirements filter (using existing requirementsAnalyzer)
        if (other_requirements && other_requirements.trim()) {
            exactMatches = filterPlansByRequirements(exactMatches, other_requirements);
        }

        let finalPlans = [];
        
        if (exactMatches.length >= 3) {
            // Use existing confidenceScorer
            const plansWithConfidence = exactMatches.map(p => ({
                ...p,
                confidence: calculateConfidence(p, { ...answers, minTier }),
                isExactMatch: true
            }));
            
            finalPlans = plansWithConfidence
                .sort((a, b) => {
                    if (a.requirementsMatchScore !== undefined && b.requirementsMatchScore !== undefined) {
                        const reqDiff = b.requirementsMatchScore - a.requirementsMatchScore;
                        if (Math.abs(reqDiff) > 5) return reqDiff;
                    }
                    
                    const confDiff = b.confidence - a.confidence;
                    if (Math.abs(confDiff) > 1) return confDiff;
                    
                    const priceA = parseFloat(a.pricing?.PKR?.monthly || a.pricing?.PKR?.annually / 12 || 999999);
                    const priceB = parseFloat(b.pricing?.PKR?.monthly || b.pricing?.PKR?.annually / 12 || 999999);
                    return priceA - priceB;
                })
                .slice(0, 3);
                
        } else if (exactMatches.length > 0 && exactMatches.length < 3) {
            // Combine exact matches with nearest neighbors
            const exactWithConfidence = exactMatches.map(p => ({
                ...p,
                confidence: calculateConfidence(p, { ...answers, minTier }),
                isExactMatch: true
            }));
            
            const remainingPlans = allPlans.filter(p => 
                !exactMatches.some(em => em.pid === p.pid)
            );
            
            // Use existing nearestNeighbor service
            const neighbors = findNearestNeighbors(remainingPlans, { ...answers, minTier }).map(p => ({
                ...p,
                isExactMatch: false
            }));
            
            const sortedExact = exactWithConfidence.sort((a, b) => b.confidence - a.confidence);
            const sortedNeighbors = neighbors.sort((a, b) => b.confidence - a.confidence);
            
            finalPlans = [...sortedExact, ...sortedNeighbors].slice(0, 3);
            
        } else {
            // Use nearest neighbor within same GID
            finalPlans = findNearestNeighbors(allPlans, { ...answers, minTier }).map(p => ({
                ...p,
                isExactMatch: false
            }));
        }

        // Format response (simplified for MCP)
        return {
            plans: finalPlans.map(p => this._formatPlanForMCP(p, currency)),
            gid,
            minTier,
            reasoning,
            match_type: finalPlans[0]?.isExactMatch ? 'exact' : 'nearest_neighbor'
        };
    }

    async searchPlans(query, currency = "USD", maxBudget = 999999, minStorage = 0, limit = 5) {
        await this.initialize();
        
        const queryLower = query.toLowerCase().trim();
        const normalizedQuery = queryLower.replace(/[\s\-_]/g, '');

        // Build MongoDB query - RELAXED filters
        const mongoQuery = { hidden: false };

        // Budget filter - IGNORE if default value (999999)
        if (maxBudget < 999999 && maxBudget > 0) {
            // Allow 20% over budget for flexibility
            mongoQuery[`pricing.${currency}.monthly`] = { $lte: String(maxBudget * 1.2) };
        }

        // Storage filter - IGNORE if 0 or not specified
        if (minStorage > 0) {
            const flexibleStorage = Math.max(1, minStorage * 0.5);
            mongoQuery.diskspace = { $gte: String(flexibleStorage) };
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

                // PRIORITY 1: Exact plan name match (normalized) - HIGHEST SCORE
                if (normalizedPlanName === normalizedQuery) {
                    score += 1000; // Very high score for exact match
                }
                // PRIORITY 2: Exact plan name match (original with spaces/hyphens)
                else if (planNameLower === queryLower) {
                    score += 900;
                }
                // PRIORITY 3: Plan name starts with query (normalized)
                else if (normalizedPlanName.startsWith(normalizedQuery)) {
                    score += 800;
                }
                // PRIORITY 4: Plan name contains query (normalized)
                else if (normalizedPlanName.includes(normalizedQuery)) {
                    score += 700;
                }
                // PRIORITY 5: Plan name contains query (original)
                else if (planNameLower.includes(queryLower)) {
                    score += 600;
                }
                // PRIORITY 6: All query words appear in plan name
                else {
                    const queryWords = queryLower.split(/[\s\-_]+/).filter(w => w.length > 2);
                    const matchedWords = queryWords.filter(word => 
                        planNameLower.includes(word)
                    );
                    if (matchedWords.length === queryWords.length && queryWords.length > 0) {
                        score += 500;
                    } else if (matchedWords.length > 0) {
                        score += 300 * (matchedWords.length / queryWords.length);
                    }
                }

                // SECONDARY: Description match (much lower priority than name)
                const queryWords = queryLower.split(/[\s\-_]+/).filter(w => w.length > 2);
                const matchedDescWords = queryWords.filter(word => descLower.includes(word));
                if (matchedDescWords.length > 0) {
                    score += 50 * (matchedDescWords.length / queryWords.length);
                }

                // TERTIARY: Config options match (lowest priority)
                if (plan.configoptions) {
                    const configStr = JSON.stringify(plan.configoptions).toLowerCase();
                    const matchedConfigWords = queryWords.filter(word => configStr.includes(word));
                    if (matchedConfigWords.length > 0) {
                        score += 20 * (matchedConfigWords.length / queryWords.length);
                    }
                }
            } else {
                // No query = show all plans with base score
                score = 50;
            }

            // Value adjustments (only if score > 0 from name/desc matching)
            if (score > 0) {
                const monthlyPrice = parseFloat(plan.pricing[currency]?.monthly || "999999");
                const diskspace = parseFloat(plan.diskspace) || 1;
                
                // Small boost for better value (doesn't override name matching)
                const valueRatio = diskspace / monthlyPrice;
                score += Math.min(10, valueRatio);
                
                // Small penalty for very expensive plans
                const expensiveThreshold = currency === 'PKR' ? 5000 : 50;
                if (monthlyPrice > expensiveThreshold) {
                    score -= 5;
                }
                
                // Small boost for free domain
                if (plan.freedomain) {
                    score += 5;
                }

                results.push({
                    plan: this._formatPlanEnhanced(plan, currency),
                    relevance_score: Math.round(score)
                });
            }
        });

        // Sort by relevance score (name matches will be at top)
        results.sort((a, b) => b.relevance_score - a.relevance_score);
        
        // Return top results
        return results.slice(0, limit);
    }

    async getPlanById(planId, currency = "USD") {
        await this.initialize();
        const plan = await HostingPlan.findOne({ pid: planId, hidden: false }).lean();
        if (!plan) return null;
        
        return {
            ...this._formatPlanEnhanced(plan, currency),
            config_options: this._parseConfigOptions(plan.configoptions),
            all_pricing: plan.pricing,
            features: this._extractFeatures(plan)
        };
    }

    async comparePlans(planIds, currency = "USD") {
        await this.initialize();
        const plans = await HostingPlan.find({ 
            pid: { $in: planIds }, 
            hidden: false 
        }).lean();

        if (plans.length === 0) {
            return { error: "No valid plans found" };
        }

        return {
            plans: plans.map(p => this._formatPlanEnhanced(p, currency)),
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

    _formatPlanForMCP(plan, currency) {
        const monthlyPrice = plan.pricing?.[currency]?.monthly || "N/A";
        const annualPrice = plan.pricing?.[currency]?.annually || "N/A";
        
        return {
            id: plan.pid,
            name: plan.name,
            description: plan.description,
            diskspace: plan.diskspace,
            free_domain: plan.freedomain,
            monthly_price: monthlyPrice,
            annual_price: annualPrice,
            currency: currency,
            order_link: `https://portal.hostbreak.com/cart.php?a=add&pid=${plan.pid}&currency=${currency === 'PKR' ? '2' : '1'}`,
            confidence: plan.confidence ? Math.round(plan.confidence) : undefined,
            is_exact_match: plan.isExactMatch,
            requirements_match_score: plan.requirementsMatchScore,
            matched_capabilities: plan.matchedCapabilities
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
            free_domain: plan.freedomain,
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
        
        if (desc.includes('wordpress')) features.push('WordPress');
        if (desc.includes('ssl')) features.push('Free SSL');
        if (desc.includes('backup')) features.push('Backups');
        if (desc.includes('email')) features.push('Email');
        if (desc.includes('cpanel')) features.push('cPanel');
        if (desc.includes('nvme')) features.push('NVMe Storage');
        if (desc.includes('ssd')) features.push('SSD Storage');
        
        features.push(`${plan.diskspace} Storage`);
        
        return features.slice(0, 5);
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

        if (plan.configoptions?.configoption) {
            plan.configoptions.configoption.forEach(opt => {
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
}

// Initialize plans manager (singleton)
let plansManager;
const getPlansManager = () => {
    if (!plansManager) {
        plansManager = new PlansManager();
    }
    return plansManager;
};

// MCP Tools definitions - OPTIMIZED
const MCP_TOOLS = [
    {
        name: "recommend_plans",
        description: "DEFAULT TOOL (use 95% of time): Get hosting recommendations based on requirements. Use for ANY hosting query including WordPress, Node.js, Python, business, etc. Returns 3 best matches.",
        inputSchema: {
            type: "object",
            properties: {
                purpose: {
                    type: "string",
                    description: "Purpose: blog, business, ecommerce, wordpress, personal, portfolio, ssl, windows",
                    default: "Other"
                },
                websites_count: {
                    type: "string",
                    description: "Number of websites: 1, 2-3, 4-10, 10+, or null if not specified",
                    enum: ["1", "2-3", "4-10", "10+", null],
                    default: null
                },
                storage_needed_gb: {
                    type: "number",
                    description: "Storage needed in GB (default 10)",
                    default: 10
                },
                monthly_budget: {
                    type: "number",
                    description: "Monthly budget in currency units (0 = no budget limit)",
                    default: 0
                },
                free_domain: {
                    type: "boolean",
                    description: "Needs free domain?",
                    default: false
                },
                needs_ssl: {
                    type: "boolean",
                    description: "Needs SSL certificate?",
                    default: false
                },
                needs_reseller: {
                    type: "boolean",
                    description: "Needs reseller hosting?",
                    default: false
                },
                needs_windows: {
                    type: "boolean",
                    description: "Needs Windows hosting?",
                    default: false
                },
                other_requirements: {
                    type: "string",
                    description: "Additional requirements in plain text",
                    default: ""
                },
                currency: {
                    type: "string",
                    enum: ["USD", "PKR"],
                    default: "USD"
                }
            }
        }
    },
    {
        name: "search_plans",
        description: "ONLY for plan NAME search (e.g. 'BIZ-5', 'Pro Plan'). DO NOT use for technology (Node.js, WordPress) or requirements - use recommend_plans instead. Returns top 5 name matches.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Plan name to search (e.g. 'BIZ-5', 'WordPress')",
                    default: ""
                },
                max_budget: {
                    type: "number",
                    description: "Max monthly price (optional, omit if not specified by user)",
                    default: 999999
                },
                currency: {
                    type: "string",
                    enum: ["USD", "PKR"],
                    default: "USD"
                },
                min_storage: {
                    type: "number",
                    description: "Min storage GB (optional, omit if not specified by user)",
                    default: 0
                },
                limit: {
                    type: "number",
                    default: 5,
                    minimum: 1,
                    maximum: 10
                }
            }
        }
    },
    {
        name: "compare_plans",
        description: "Compare 2-3 plans side-by-side. ONLY use when user explicitly asks to compare specific plan IDs.",
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
    },
    {
        name: "lookup_invoice",
        description: "Find invoice(s) by domain, email, or invoice ID. Returns invoice status, amount, due date. If multiple unpaid invoices exist, returns all of them with total amount. May take 1-2 seconds. WAIT for response, do NOT call other tools.",
        inputSchema: {
            type: "object",
            properties: {
                invoice_id: {
                    type: "string",
                    description: "Invoice ID or number (optional if domain/email provided)"
                },
                domain: {
                    type: "string",
                    description: "Domain name to identify client (optional)"
                },
                email: {
                    type: "string",
                    description: "Client email address (optional)"
                },
                phone: {
                    type: "string",
                    description: "Phone number for validation (optional)"
                },
                client_id: {
                    type: "string",
                    description: "WHMCS client ID (optional, auto-resolved if not provided)"
                }
            }
        }
    },
    {
        name: "check_domain_availability",
        description: "Check if a domain name is available for registration. Returns availability status and pricing. Default currency is PKR (Pakistan Rupees). If user mentions USD or dollars, use currency='USD' to get prices in US Dollars. Returns up to 3 alternative suggestions if domain is taken.",
        inputSchema: {
            type: "object",
            properties: {
                domain: {
                    type: "string",
                    description: "Domain name to check (e.g., 'example.com', 'hostbreak.pk')",
                    pattern: "^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$"
                },
                currency: {
                    type: "string",
                    enum: ["PKR", "USD"],
                    default: "PKR",
                    description: "Currency for pricing. Use 'PKR' for Pakistan Rupees (default) or 'USD' for US Dollars. Only change to USD if user explicitly mentions USD or dollars."
                }
            },
            required: ["domain"]
        }
    },
    {
        name: "lookup_ticket",
        description: "Find support ticket by ticket number with automatic phone validation from uChat. Returns ticket details, status, client info. Only requires ticket number - phone is automatically fetched from uChat variables.",
        inputSchema: {
            type: "object",
            properties: {
                ticket: {
                    type: "string",
                    description: "Ticket number to lookup (required). Should be numeric."
                },
                phone: {
                    type: "string",
                    description: "Client phone number (automatically filled from uChat variables)",
                    default: "{{User_id}}"
                }
            },
            required: ["ticket"]
        }
    },
    {
        name: "renew_service",
        description: "Renew hosting service or domain with automatic client resolution. Supports both hosting services and domain renewals. Phone validation is automatic via uChat variables. Returns invoice details or existing invoice information.",
        inputSchema: {
            type: "object",
            properties: {
                domain: {
                    type: "string",
                    description: "Domain name to renew (required). Can be hosting service domain or standalone domain."
                },
                email: {
                    type: "string",
                    description: "Client email for identification (optional, auto-resolved if not provided)"
                },
                phone: {
                    type: "string",
                    description: "Client phone number (automatically filled from uChat variables)",
                    default: "{{User_id}}"
                },
                clientId: {
                    type: "string",
                    description: "WHMCS client ID (optional, auto-resolved if not provided)"
                }
            },
            required: ["domain"]
        }
    }
];

// Execute tool function
async function executeTool(name, args) {
    const startTime = Date.now();
    
    // Log incoming request with essential params only
    log('info', `🔧 ${name} started`);
    
    try {
        const manager = getPlansManager();
        let result;
        
        switch (name) {
            case "recommend_plans":
                log('info', `🔍 Executing recommend_plans`);
                
                const recommendations = await manager.recommendPlans(args);
                
                if (recommendations.plans.length === 0) {
                    result = {
                        success: true,
                        data: {
                            plans: [],
                            message: recommendations.message || 'No plans found',
                            reasoning: recommendations.reasoning
                        }
                    };
                } else {
                    result = {
                        success: true,
                        data: {
                            plans: recommendations.plans,
                            count: recommendations.plans.length,
                            gid: recommendations.gid,
                            min_tier: recommendations.minTier,
                            reasoning: recommendations.reasoning,
                            match_type: recommendations.match_type
                        }
                    };
                }
                
                // Log metrics
                logMetric('recommend_plans_count', recommendations.plans.length, {
                    gid: recommendations.gid,
                    match_type: recommendations.match_type
                });
                break;
                
            case "search_plans":
                const query = args.query || "";
                const currency = args.currency || "USD";
                const maxBudget = args.max_budget || 999999;
                const minStorage = args.min_storage || 0;
                const limit = Math.min(args.limit || 5, 10);
                
                log('info', `🔍 Executing search_plans: query="${query}", budget=${maxBudget}, storage=${minStorage}, limit=${limit}`);
                
                const searchResults = await manager.searchPlans(query, currency, maxBudget, minStorage, limit);
                
                if (searchResults.length === 0) {
                    result = {
                        success: true,
                        data: [],
                        count: 0,
                        message: `No plans found. Try different keywords.`
                    };
                } else {
                    result = { 
                        success: true, 
                        data: searchResults,
                        count: searchResults.length
                    };
                }
                break;

            case "compare_plans":
                const planIds = args.plan_ids || [];
                if (planIds.length < 2 || planIds.length > 3) {
                    result = { success: false, error: "Please provide 2-3 plan IDs to compare" };
                } else {
                    const currency4 = args.currency || "USD";
                    
                    log('info', `📊 Executing compare_plans: planIds=${planIds.join(',')}, currency=${currency4}`);
                    
                    const result4 = await manager.comparePlans(planIds, currency4);
                    if (result4.error) {
                        result = { success: false, error: result4.error };
                    } else {
                        result = { success: true, data: result4 };
                    }
                }
                break;

            case "lookup_invoice":
                const invoiceStartTime = Date.now();
                log('info', `🔍 lookup_invoice: email=${args.email ? '[PROVIDED]' : 'N/A'}, domain=${args.domain || 'N/A'}, invoice_id=${args.invoice_id || 'N/A'}`);
                
                // Import invoice controller
                const { invoiceLookup } = require('./controllers/invoiceController');
                
                // Call the invoice lookup function
                const invoiceResult = await invoiceLookup({
                    invoiceId: args.invoice_id,
                    domain: args.domain,
                    email: args.email,
                    phone: args.phone,
                    clientId: args.client_id
                });
                
                const invoiceDuration = Date.now() - invoiceStartTime;
                
                // Wrap the result to match the expected format
                if (invoiceResult.success) {
                    const { success, ...invoiceData } = invoiceResult;
                    result = {
                        success: true,
                        data: invoiceData
                    };
                    
                    // Log success with key metrics
                    if (invoiceData.multipleInvoices) {
                        log('info', `✅ lookup_invoice: Found ${invoiceData.count} invoices, total=${invoiceData.totalAmount} (${invoiceDuration}ms)`);
                    } else {
                        log('info', `✅ lookup_invoice: Invoice #${invoiceData.invoiceId}, status=${invoiceData.status} (${invoiceDuration}ms)`);
                    }
                } else {
                    result = invoiceResult;
                    log('info', `❌ lookup_invoice: ${invoiceResult.error} (${invoiceDuration}ms)`);
                }
                break;

            case "check_domain_availability":
                const domainStartTime = Date.now();
                log('info', `🌐 check_domain_availability: domain=${args.domain}, currency=${args.currency || 'PKR'}`);
                
                // Import domain service functions
                const { 
                    checkDomainAvailability: checkSingleDomain,
                    checkMultipleDomains,
                    extractTld,
                    generateFallbackSuggestions
                } = require('../src/services/domainService');
                const { getPricingForTld } = require('../src/services/tldPricing');
                
                // Validate domain
                if (!args.domain || typeof args.domain !== 'string') {
                    result = {
                        success: false,
                        error: 'Domain name is required'
                    };
                    break;
                }
                
                // Normalize domain
                const normalizedDomain = args.domain.toLowerCase().trim();
                
                // Basic validation
                const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
                if (!domainRegex.test(normalizedDomain)) {
                    result = {
                        success: false,
                        error: 'Invalid domain format. Please provide a valid domain name (e.g., example.com)'
                    };
                    break;
                }
                
                try {
                    // Get currency from args, default to PKR
                    const currency = args.currency || 'PKR';
                    
                    // Check primary domain (fast - single WHMCS call ~1-2s)
                    const primaryCheck = await checkSingleDomain(normalizedDomain);
                    
                    if (primaryCheck.available) {
                        // Get pricing for available domain
                        const tld = await extractTld(normalizedDomain);
                        const tldWithoutDot = tld ? tld.slice(1) : null;
                        const pricingDoc = tldWithoutDot ? await getPricingForTld(tldWithoutDot, currency) : null;
                        
                        // Domain is available - return with pricing
                        result = {
                            success: true,
                            data: {
                                domain: normalizedDomain,
                                available: true,
                                message: `${normalizedDomain} is available for registration`,
                                currency: currency,
                                pricing: pricingDoc ? {
                                    register: pricingDoc.register,
                                    renew: pricingDoc.renew,
                                    transfer: pricingDoc.transfer,
                                    currency: pricingDoc.currency_code || currency
                                } : null
                            }
                        };
                    } else {
                        // Domain is taken - generate quick suggestions (limit to 3 for speed)
                        const suggestions = await generateFallbackSuggestions(normalizedDomain);
                        
                        // Check only first 3 suggestions in parallel (~2-3s)
                        const checked = await checkMultipleDomains(suggestions.slice(0, 3), 3);
                        const available = checked.filter(r => r.available).map(r => r.domain);
                        
                        // Get pricing for suggestions
                        const pricedSuggestions = await Promise.all(available.map(async (domain) => {
                            const tld = await extractTld(domain);
                            const tldWithoutDot = tld ? tld.slice(1) : null;
                            const pricing = tldWithoutDot ? await getPricingForTld(tldWithoutDot, currency) : null;
                            
                            return {
                                domain: domain,
                                pricing: pricing ? {
                                    register: pricing.register,
                                    renew: pricing.renew,
                                    transfer: pricing.transfer,
                                    currency: pricing.currency_code || currency
                                } : null
                            };
                        }));
                        
                        result = {
                            success: true,
                            data: {
                                domain: normalizedDomain,
                                available: false,
                                message: `${normalizedDomain} is already registered`,
                                currency: currency,
                                suggestions: pricedSuggestions
                            }
                        };
                    }
                    
                    const domainDuration = Date.now() - domainStartTime;
                    
                    // Log success
                    if (result.data.available) {
                        log('info', `✅ check_domain_availability: ${result.data.domain} is available (${domainDuration}ms)`);
                    } else {
                        log('info', `✅ check_domain_availability: ${result.data.domain} is taken, ${result.data.suggestions?.length || 0} suggestions (${domainDuration}ms)`);
                    }
                    
                } catch (error) {
                    const domainDuration = Date.now() - domainStartTime;
                    result = {
                        success: false,
                        error: error.message || 'Failed to check domain availability'
                    };
                    log('info', `❌ check_domain_availability: ${error.message} (${domainDuration}ms)`);
                }
                break;

            case "lookup_ticket":
                const ticketStartTime = Date.now();
                log('info', `🎫 lookup_ticket: phone=${args.phone ? '[PROVIDED]' : 'N/A'}, ticket=${args.ticket || 'N/A'}`);
                
                // Import ticket controller
                const { lookupTicket } = require('./controllers/ticketController');
                
                // Call the ticket lookup function
                const ticketResult = await lookupTicket({
                    phone: args.phone,
                    ticket: args.ticket
                });
                
                const ticketDuration = Date.now() - ticketStartTime;
                
                // Wrap the result to match the expected format
                if (ticketResult.success) {
                    const { success, ...ticketData } = ticketResult;
                    result = {
                        success: true,
                        data: ticketData
                    };
                    
                    // Log success with key metrics
                    log('info', `✅ lookup_ticket: Ticket #${ticketData.ticket?.ticketNumber}, status=${ticketData.ticket?.status} (${ticketDuration}ms)`);
                } else {
                    result = ticketResult;
                    log('info', `❌ lookup_ticket: ${ticketResult.error} (${ticketDuration}ms)`);
                }
                break;

            case "renew_service":
                const renewStartTime = Date.now();
                log('info', `🔄 renew_service: domain=${args.domain || 'N/A'}, email=${args.email ? '[PROVIDED]' : 'N/A'}, phone=${args.phone ? '[PROVIDED]' : 'N/A'}`);
                
                // Import renew service controller
                const { renewService } = require('./controllers/renewServiceController');
                
                // Call the renew service function
                const renewResult = await renewService({
                    domain: args.domain,
                    email: args.email,
                    phone: args.phone,
                    clientId: args.clientId
                });
                
                const renewDuration = Date.now() - renewStartTime;
                
                // Wrap the result to match the expected format
                if (renewResult.success) {
                    const { success, ...renewData } = renewResult;
                    result = {
                        success: true,
                        data: renewData
                    };
                    
                    // Log success with key metrics
                    if (renewData.existingInvoice) {
                        log('info', `✅ renew_service: Existing invoice #${renewData.invoiceId}, amount=${renewData.amount} (${renewDuration}ms)`);
                    } else if (renewData.invoiceGenerated) {
                        log('info', `✅ renew_service: New invoice #${renewData.invoiceId}, amount=${renewData.amount} (${renewDuration}ms)`);
                    } else {
                        log('info', `✅ renew_service: Renewal initiated for ${renewData.domain} (${renewDuration}ms)`);
                    }
                } else {
                    result = renewResult;
                    log('info', `❌ renew_service: ${renewResult.error} (${renewDuration}ms)`);
                }
                break;

            default:
                result = { success: false, error: `Unknown tool: ${name}` };
        }
        
        const duration = Date.now() - startTime;
        
        // Log completion with performance metrics
        if (result.success) {
            log('info', `✅ ${name} completed (${duration}ms)`);
            
            // Log performance asynchronously (non-blocking)
            const metadata = {};
            if (name === 'lookup_invoice' && result.data) {
                metadata.multiple_invoices = result.data.multipleInvoices || false;
                metadata.invoice_count = result.data.count || 1;
            } else if (name === 'recommend_plans' && result.data) {
                metadata.plan_count = result.data.count || 0;
            } else if (name === 'search_plans' && result.data) {
                metadata.result_count = Array.isArray(result.data) ? result.data.length : 0;
            } else if (name === 'check_domain_availability' && result.data) {
                metadata.available = result.data.available || false;
                metadata.suggestions_count = result.data.suggestions?.length || 0;
            }
            
            logPerformance(name, duration, true, metadata);
        } else {
            log('info', `❌ ${name} failed: ${result.error} (${duration}ms)`);
            logPerformance(name, duration, false, { error: result.error });
            logError(name, result.error);
        }
        
        return result;
        
    } catch (error) {
        const duration = Date.now() - startTime;
        log('error', `💥 Error executing tool ${name} after ${duration}ms: ${error.message}`);
        log('error', `📤 Error response: ${JSON.stringify({ success: false, error: error.message }, null, 2)}`);
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

// Cache for static responses (tools list, capabilities)
const STATIC_RESPONSE_CACHE = {
    initialize: {
        jsonrpc: "2.0",
        result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
                name: "plans-mcp-server-mongodb",
                version: "2.0.0"
            }
        }
    },
    toolsList: {
        jsonrpc: "2.0",
        result: { tools: MCP_TOOLS }
    }
};

// Request counter for monitoring
let requestStats = {
    initialize: 0,
    toolsList: 0,
    toolsCall: 0,
    lastReset: Date.now()
};

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
    res.write(`data: ${JSON.stringify({ status: 'connected', server: 'plans-mcp-server-mongodb' })}\n\n`);

    const capabilities = {
        jsonrpc: "2.0",
        id: "init",
        result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
                name: "plans-mcp-server-mongodb",
                version: "2.0.0"
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
app.get('/', async (req, res) => {
    logger.logFunctionCall('root_endpoint', { method: 'GET', client_ip: req.ip });
    try {
        const manager = getPlansManager();
        await manager.initialize();
        const count = await HostingPlan.countDocuments();
        
        res.json({
            name: "Plans MCP Server - MongoDB Production",
            version: "2.0.0",
            description: "Production-grade MCP Server with MongoDB backend for uChat integration",
            database: "MongoDB",
            plans_loaded: count,
            tools_available: MCP_TOOLS.length,
            endpoints: {
                health: "/health",
                sse: "/sse",
                logs: "/logs"
            }
        });
    } catch (error) {
        res.status(500).json({
            error: "Failed to initialize",
            message: error.message
        });
    }
});

app.post('/', async (req, res) => {
    const { method, id, params } = req.body;
    
    try {
        switch (method) {
            case "initialize":
                requestStats.initialize++;
                // Return cached response with dynamic ID
                const initResponse = { ...STATIC_RESPONSE_CACHE.initialize, id };
                res.json(initResponse);
                break;

            case "tools/list":
                requestStats.toolsList++;
                // Return cached response with dynamic ID
                const toolsResponse = { ...STATIC_RESPONSE_CACHE.toolsList, id };
                res.json(toolsResponse);
                
                // Log excessive calls (more than 10 per minute)
                if (requestStats.toolsList > 10 && Date.now() - requestStats.lastReset < 60000) {
                    log('warning', `⚠️ Excessive tools/list calls: ${requestStats.toolsList} in last minute`);
                }
                break;

            case "tools/call":
                requestStats.toolsCall++;
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
        log('error', `Error handling request: ${error.message}`);
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

// Reset stats every minute
setInterval(() => {
    const now = Date.now();
    const duration = now - requestStats.lastReset;
    
    // Log stats if there was activity
    if (requestStats.toolsList > 0 || requestStats.toolsCall > 0) {
        log('info', `📊 Request stats (last ${Math.round(duration/1000)}s): initialize=${requestStats.initialize}, tools/list=${requestStats.toolsList}, tools/call=${requestStats.toolsCall}`);
    }
    
    // Reset counters
    requestStats = {
        initialize: 0,
        toolsList: 0,
        toolsCall: 0,
        lastReset: now
    };
}, 60000);

// Health check
app.get('/health', async (req, res) => {
    logger.logFunctionCall('health_check', { client_ip: req.ip });
    try {
        const manager = getPlansManager();
        await manager.initialize();
        const count = await HostingPlan.countDocuments();
        
        res.json({
            status: "healthy",
            server: "Plans MCP Server - MongoDB Production",
            database: "MongoDB",
            plans_loaded: count,
            tools_available: MCP_TOOLS.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: "unhealthy",
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Logs endpoint
app.get('/logs', (req, res) => {
    logger.logFunctionCall('logs_endpoint', { client_ip: req.ip, format: req.query.format });
    const format = req.query.format || 'summary';
    const lines = parseInt(req.query.lines) || 50;
    
    if (format === 'full') {
        const logs = logger.getLogContents();
        res.json({
            format: 'full',
            logs: logs,
            timestamp: new Date().toISOString()
        });
    } else if (format === 'recent') {
        // Get recent logs (last N lines)
        const logs = logger.getLogContents();
        const recentLogs = logs.slice(-lines);
        res.json({
            format: 'recent',
            lines: recentLogs.length,
            logs: recentLogs,
            timestamp: new Date().toISOString()
        });
    } else {
        const stats = logger.getLogStats();
        res.json({
            format: 'summary',
            stats: stats,
            timestamp: new Date().toISOString(),
            hint: 'Use ?format=recent&lines=50 to see last 50 log entries'
        });
    }
});

// Performance logs endpoint
app.get('/logs/performance', (req, res) => {
    const { getLogStats } = require('./utils/performanceLogger');
    const stats = getLogStats();
    
    res.json({
        ...stats,
        timestamp: new Date().toISOString(),
        endpoints: {
            performance: '/logs/performance',
            errors: '/logs/errors',
            metrics: '/logs/metrics'
        }
    });
});

// Read performance log file
app.get('/logs/performance/view', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const lines = parseInt(req.query.lines) || 100;
    
    try {
        const logFile = path.join(__dirname, 'logs', 'performance.log');
        const content = fs.readFileSync(logFile, 'utf8');
        const logLines = content.trim().split('\n');
        const recentLines = logLines.slice(-lines);
        
        res.json({
            lines: recentLines.length,
            logs: recentLines,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.json({
            error: 'Log file not found or empty',
            message: err.message
        });
    }
});

// Export for server wrapper
module.exports = app;
