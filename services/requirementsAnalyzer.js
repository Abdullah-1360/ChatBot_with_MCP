/**
 * Requirements Analyzer Service
 * Intelligently parses and matches "other_requirements" against plan details
 */

const { createLogger } = require('../utils/logger');
const logger = createLogger('REQUIREMENTS_ANALYZER');

/**
 * Extract numeric values from text
 * Examples: "100 email accounts", "50GB storage", "unlimited bandwidth"
 */
function extractNumericRequirement(text, keywords) {
  const lowerText = text.toLowerCase();
  
  // Check for unlimited
  if (lowerText.includes('unlimited') || lowerText.includes('unmetered')) {
    return { value: Infinity, isUnlimited: true };
  }
  
  // Look for numbers near keywords
  for (const keyword of keywords) {
    const regex = new RegExp(`(\\d+)\\s*(?:gb|mb|tb)?\\s*${keyword}`, 'i');
    const match = lowerText.match(regex);
    if (match) {
      return { value: parseInt(match[1]), isUnlimited: false };
    }
    
    // Also check reverse pattern: "email accounts: 100"
    const reverseRegex = new RegExp(`${keyword}[:\\s]+(\\d+)`, 'i');
    const reverseMatch = lowerText.match(reverseRegex);
    if (reverseMatch) {
      return { value: parseInt(reverseMatch[1]), isUnlimited: false };
    }
  }
  
  return null;
}

/**
 * Parse other_requirements into structured data
 * @param {string} otherRequirements - Free text requirements from user
 * @returns {Object} - Structured requirements object
 */
function parseRequirements(otherRequirements) {
  if (!otherRequirements || typeof otherRequirements !== 'string') {
    return {};
  }
  
  const requirements = {};
  const text = otherRequirements.toLowerCase();
  
  // Email accounts (check for "business email" specifically)
  const emailReq = extractNumericRequirement(text, [
    'email', 'emails', 'email account', 'email accounts', 'mailbox', 'mailboxes',
    'business email', 'business emails', 'mail account', 'mail accounts'
  ]);
  if (emailReq) {
    requirements.emailAccounts = emailReq;
    logger.debug('Detected email requirement', emailReq);
  }
  
  // Databases
  const dbReq = extractNumericRequirement(text, [
    'database', 'databases', 'mysql', 'db', 'dbs', 'sql'
  ]);
  if (dbReq) {
    requirements.databases = dbReq;
    logger.debug('Detected database requirement', dbReq);
  }
  
  // Bandwidth
  const bwReq = extractNumericRequirement(text, [
    'bandwidth', 'traffic', 'data transfer', 'transfer'
  ]);
  if (bwReq) {
    requirements.bandwidth = bwReq;
    logger.debug('Detected bandwidth requirement', bwReq);
  }
  
  // Subdomains
  const subdomainReq = extractNumericRequirement(text, [
    'subdomain', 'subdomains', 'sub-domain', 'sub-domains'
  ]);
  if (subdomainReq) {
    requirements.subdomains = subdomainReq;
    logger.debug('Detected subdomain requirement', subdomainReq);
  }
  
  // FTP accounts
  const ftpReq = extractNumericRequirement(text, [
    'ftp', 'ftp account', 'ftp accounts', 'sftp'
  ]);
  if (ftpReq) {
    requirements.ftpAccounts = ftpReq;
    logger.debug('Detected FTP requirement', ftpReq);
  }
  
  // Addon domains
  const addonReq = extractNumericRequirement(text, [
    'addon domain', 'addon domains', 'additional domain', 'additional domains',
    'extra domain', 'extra domains', 'parked domain', 'parked domains'
  ]);
  if (addonReq) {
    requirements.addonDomains = addonReq;
    logger.debug('Detected addon domain requirement', addonReq);
  }
  
  // Feature keywords (boolean checks)
  const features = {
    ssl: /\b(ssl|https|secure|certificate|tls)\b/i.test(text),
    backup: /\b(backup|backups|restore|snapshot)\b/i.test(text),
    cpanel: /\b(cpanel|control panel|cp)\b/i.test(text),
    wordpress: /\b(wordpress|wp|woocommerce)\b/i.test(text),
    staging: /\b(staging|test site|development)\b/i.test(text),
    cdn: /\b(cdn|cloudflare|content delivery)\b/i.test(text),
    migration: /\b(migrat|transfer|move|switch)\b/i.test(text),
    support: /\b(support|help|assistance|24\/7|priority)\b/i.test(text),
    ssd: /\b(ssd|solid state|nvme)\b/i.test(text),
    litespeed: /\b(litespeed|lscache|ls cache)\b/i.test(text),
    python: /\b(python|django|flask)\b/i.test(text),
    nodejs: /\b(node|nodejs|node\.js|npm)\b/i.test(text),
    git: /\b(git|github|gitlab|version control)\b/i.test(text),
    ssh: /\b(ssh|shell access|terminal)\b/i.test(text),
    cron: /\b(cron|scheduled task|automation)\b/i.test(text)
  };
  
  // Only include features that are requested
  const requestedFeatures = Object.entries(features)
    .filter(([_, value]) => value)
    .map(([key, _]) => key);
  
  if (requestedFeatures.length > 0) {
    requirements.features = requestedFeatures;
    logger.debug('Detected features', requestedFeatures);
  }
  
  return requirements;
}

/**
 * Extract plan capabilities from description
 * @param {Object} plan - Plan object with description
 * @returns {Object} - Extracted capabilities
 */
function extractPlanCapabilities(plan) {
  const description = (plan.description || '').toLowerCase();
  const capabilities = {};
  
  // Email accounts
  const emailMatch = description.match(/(\d+|unlimited)\s*(?:email|mailbox)/i);
  if (emailMatch) {
    capabilities.emailAccounts = emailMatch[1] === 'unlimited' ? Infinity : parseInt(emailMatch[1]);
  }
  
  // Databases
  const dbMatch = description.match(/(\d+|unlimited)\s*(?:database|mysql|db)/i);
  if (dbMatch) {
    capabilities.databases = dbMatch[1] === 'unlimited' ? Infinity : parseInt(dbMatch[1]);
  }
  
  // Bandwidth
  const bwMatch = description.match(/(\d+|unlimited|unmetered)\s*(?:gb|tb)?\s*(?:bandwidth|traffic)/i);
  if (bwMatch) {
    capabilities.bandwidth = bwMatch[1] === 'unlimited' || bwMatch[1] === 'unmetered' 
      ? Infinity 
      : parseInt(bwMatch[1]);
  }
  
  // Subdomains
  const subdomainMatch = description.match(/(\d+|unlimited)\s*(?:subdomain)/i);
  if (subdomainMatch) {
    capabilities.subdomains = subdomainMatch[1] === 'unlimited' ? Infinity : parseInt(subdomainMatch[1]);
  }
  
  // FTP accounts
  const ftpMatch = description.match(/(\d+|unlimited)\s*(?:ftp)/i);
  if (ftpMatch) {
    capabilities.ftpAccounts = ftpMatch[1] === 'unlimited' ? Infinity : parseInt(ftpMatch[1]);
  }
  
  // Addon domains
  const addonMatch = description.match(/(\d+|unlimited)\s*(?:addon domain|additional domain|parked domain)/i);
  if (addonMatch) {
    capabilities.addonDomains = addonMatch[1] === 'unlimited' ? Infinity : parseInt(addonMatch[1]);
  }
  
  // Features (boolean)
  capabilities.features = [];
  
  if (/\b(ssl|https|free ssl|let'?s encrypt)\b/i.test(description)) {
    capabilities.features.push('ssl');
  }
  if (/\b(backup|daily backup|weekly backup)\b/i.test(description)) {
    capabilities.features.push('backup');
  }
  if (/\b(cpanel|control panel)\b/i.test(description)) {
    capabilities.features.push('cpanel');
  }
  if (/\b(wordpress|wp|woocommerce)\b/i.test(description)) {
    capabilities.features.push('wordpress');
  }
  if (/\b(staging|test site)\b/i.test(description)) {
    capabilities.features.push('staging');
  }
  if (/\b(cdn|cloudflare)\b/i.test(description)) {
    capabilities.features.push('cdn');
  }
  if (/\b(migration|free migration|transfer)\b/i.test(description)) {
    capabilities.features.push('migration');
  }
  if (/\b(24\/7|priority support|dedicated support)\b/i.test(description)) {
    capabilities.features.push('support');
  }
  if (/\b(ssd|solid state|nvme)\b/i.test(description)) {
    capabilities.features.push('ssd');
  }
  if (/\b(litespeed|lscache)\b/i.test(description)) {
    capabilities.features.push('litespeed');
  }
  if (/\b(python|django|flask)\b/i.test(description)) {
    capabilities.features.push('python');
  }
  if (/\b(node|nodejs|npm)\b/i.test(description)) {
    capabilities.features.push('nodejs');
  }
  if (/\b(git|github|gitlab)\b/i.test(description)) {
    capabilities.features.push('git');
  }
  if (/\b(ssh|shell access)\b/i.test(description)) {
    capabilities.features.push('ssh');
  }
  if (/\b(cron|scheduled task)\b/i.test(description)) {
    capabilities.features.push('cron');
  }
  
  return capabilities;
}

/**
 * Calculate match score between requirements and plan capabilities
 * @param {Object} requirements - Parsed user requirements
 * @param {Object} capabilities - Extracted plan capabilities
 * @returns {number} - Match score (0-100)
 */
function calculateMatchScore(requirements, capabilities) {
  let totalWeight = 0;
  let matchedWeight = 0;
  
  // Numeric requirements (weight: 20 each)
  const numericFields = ['emailAccounts', 'databases', 'bandwidth', 'subdomains', 'ftpAccounts', 'addonDomains'];
  
  for (const field of numericFields) {
    if (requirements[field]) {
      totalWeight += 20;
      
      const required = requirements[field];
      const available = capabilities[field];
      
      if (available !== undefined) {
        if (required.isUnlimited && available === Infinity) {
          // Perfect match for unlimited
          matchedWeight += 20;
        } else if (available === Infinity) {
          // Plan offers unlimited, user needs specific amount
          matchedWeight += 20;
        } else if (available >= required.value) {
          // Plan meets or exceeds requirement
          matchedWeight += 20;
        } else if (available >= required.value * 0.7) {
          // Plan is close (70%+)
          matchedWeight += 14;
        } else if (available >= required.value * 0.5) {
          // Plan is somewhat close (50%+)
          matchedWeight += 10;
        }
      }
    }
  }
  
  // Feature requirements (weight: 10 each)
  if (requirements.features && requirements.features.length > 0) {
    for (const feature of requirements.features) {
      totalWeight += 10;
      
      if (capabilities.features && capabilities.features.includes(feature)) {
        matchedWeight += 10;
      }
    }
  }
  
  // If no requirements specified, return neutral score
  if (totalWeight === 0) {
    return 50;
  }
  
  // Calculate percentage
  const score = Math.round((matchedWeight / totalWeight) * 100);
  return score;
}

/**
 * Filter and score plans based on other_requirements
 * @param {Array} plans - Array of plan objects
 * @param {string} otherRequirements - User's other requirements text
 * @returns {Array} - Plans with match scores, sorted by score
 */
function filterPlansByRequirements(plans, otherRequirements) {
  if (!otherRequirements || !plans || plans.length === 0) {
    return plans;
  }
  
  logger.info('Analyzing other requirements', { 
    requirementsText: otherRequirements,
    planCount: plans.length 
  });
  
  // Parse user requirements
  const requirements = parseRequirements(otherRequirements);
  
  if (Object.keys(requirements).length === 0) {
    logger.info('No specific requirements detected in text');
    return plans;
  }
  
  logger.info('Parsed requirements', requirements);
  
  // Extract capabilities and calculate scores for each plan
  const scoredPlans = plans.map(plan => {
    const capabilities = extractPlanCapabilities(plan);
    const matchScore = calculateMatchScore(requirements, capabilities);
    
    logger.debug('Plan match analysis', {
      planName: plan.name,
      capabilities,
      matchScore
    });
    
    return {
      ...plan,
      requirementsMatchScore: matchScore,
      matchedCapabilities: capabilities
    };
  });
  
  // Sort by match score (descending)
  const sortedPlans = scoredPlans.sort((a, b) => {
    return (b.requirementsMatchScore || 0) - (a.requirementsMatchScore || 0);
  });
  
  // Filter out plans with very low scores (below 30%)
  const filteredPlans = sortedPlans.filter(p => (p.requirementsMatchScore || 50) >= 30);
  
  logger.info('Requirements matching complete', {
    totalPlans: plans.length,
    filteredPlans: filteredPlans.length,
    topScore: filteredPlans[0]?.requirementsMatchScore || 0
  });
  
  return filteredPlans;
}

module.exports = {
  parseRequirements,
  extractPlanCapabilities,
  calculateMatchScore,
  filterPlansByRequirements
};
