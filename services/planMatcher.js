// api/services/planMatcher.js
const { PURPOSE, STORAGE_TIER } = require('../config/constants');

/**
 * Keyword mappings for intelligent routing
 */
const KEYWORD_MAPPINGS = {
  ecommerce: ['shop', 'store', 'commerce', 'ecommerce', 'e-commerce', 'woocommerce', 'shopping', 'cart', 'payment', 'checkout', 'product'],
  wordpress: ['personal', 'catalogue', 'catalog', 'normal', 'blog', 'content', 'article', 'post', 'news', 'magazine'],
  business: ['business', 'corporate', 'application', 'app', 'saas', 'software', 'enterprise', 'professional', 'company'],
  ssl: ['certificate', 'cert', 'secure', 'ssl', 'https', 'security', 'encryption', 'tls'],
  windows: ['asp.net', 'asp', '.net', 'dotnet', '.net core', 'aspnet', 'c#', 'csharp', 'mssql', 'ms sql', 'iis', 'windows']
};

/**
 * Enhanced plan matcher with robust routing logic
 * Routes based on: purpose, websites_count, storage_needed_gb, needs_ssl, needs_reseller
 * Includes intelligent keyword detection for natural language input
 * 
 * @param {Object} answers - User requirements
 * @returns {Object} { gid, minTier, reasoning } - Matched group ID, minimum tier, and reasoning
 */
module.exports = function planMatcher(answers) {
  let { purpose, websites_count, needs_reseller, needs_ssl, needs_windows, storage_needed_gb } = answers;

  // 1. Normalize and analyze inputs
  const cleanCount = normaliseCount(websites_count);
  const minTier = tierOf(cleanCount);
  const storageTier = getStorageTier(storage_needed_gb);
  const isHighVolume = cleanCount === '10+';
  const isMultiSite = cleanCount !== '1';
  
  // Detect keywords in purpose field for intelligent routing
  const detectedIntent = detectKeywords(purpose);
  
  // Auto-detect Windows requirement from keywords
  if (detectedIntent === 'windows') {
    needs_windows = true;
    answers.needs_windows = true;
  }

  // 2. Priority-based routing (order matters!)
  
  // PRIORITY 1: SSL Certificates
  if (needs_ssl === true || detectedIntent === 'ssl') {
    return { 
      gid: 6, 
      minTier, 
      reasoning: 'SSL certificate requested' 
    };
  }
  
  // PRIORITY 2: Reseller Hosting
  if (needs_reseller) {
    return { 
      gid: 2, 
      minTier, 
      reasoning: 'Reseller hosting for managing client sites' 
    };
  }
  
  // PRIORITY 3: E-commerce
  if (detectedIntent === 'ecommerce' || purpose === PURPOSE.ECOM) {
    return { 
      gid: 21, 
      minTier, 
      reasoning: 'E-commerce/store detected - WooCommerce optimized hosting' 
    };
  }
  
  // PRIORITY 4: Business/Corporate
  if (detectedIntent === 'business' || purpose === PURPOSE.BUSINESS) {
    return { 
      gid: 25, 
      minTier, 
      reasoning: 'Business/corporate hosting requested' 
    };
  }
  
  // PRIORITY 5: WordPress
  if (detectedIntent === 'wordpress' || purpose === PURPOSE.BLOG || purpose === PURPOSE.PORTFOLIO) {
    return { 
      gid: 20, 
      minTier, 
      reasoning: 'Personal/blog/catalogue site - WordPress hosting' 
    };
  }
  
  // PRIORITY 6: High volume
  if (isHighVolume) {
    return { 
      gid: 25, 
      minTier, 
      reasoning: 'High volume hosting for 10+ websites' 
    };
  }
  
  // PRIORITY 7: Large storage
  if (storageTier === STORAGE_TIER.LARGE) {
    return { 
      gid: 25, 
      minTier, 
      reasoning: 'Large storage requirements (>50GB)' 
    };
  }
  
  // PRIORITY 8: High-parameter requests
  if (minTier === 'upper' && storageTier === STORAGE_TIER.MEDIUM && storage_needed_gb >= 40) {
    return { 
      gid: 25, 
      minTier, 
      reasoning: 'High-parameter requirements (4+ sites with 40+ GB storage)' 
    };
  }
  
  // PRIORITY 9: Multi-site with medium storage
  if (isMultiSite && storageTier === STORAGE_TIER.MEDIUM) {
    return { 
      gid: 20, 
      minTier, 
      reasoning: 'Multiple sites with moderate storage needs' 
    };
  }
  
  // PRIORITY 10: Default fallback
  return { 
    gid: 1, 
    minTier, 
    reasoning: 'General purpose cPanel hosting' 
  };
};

/* ---------- helpers ---------- */

function normaliseCount(raw) {
  const str = String(raw || '').toLowerCase().replace(/\s+/g, '');

  if (str === '1' || str === 'one' || str === 'single') return '1';
  if (str === '2-3' || str === '2' || str === '3' || str === 'two' || str === 'three') return '2-3';
  if (str === '4-10' || str === '4' || str === '5' || str === '6' || str === '7' || str === '8' || str === '9' || str === '10' ||
      str === 'four' || str === 'five' || str === 'six' || str === 'seven' || str === 'eight' || str === 'nine' || str === 'ten') return '4-10';
  if (str === '10+' || str === 'unlimited' || str === 'infinity' || str === 'plus' || str.includes('unlimited') || str.includes('10+')) return '10+';
  
  const numValue = parseInt(str);
  if (!isNaN(numValue) && numValue > 10) return '10+';
  if (!isNaN(numValue) && numValue >= 4) return '4-10';
  if (!isNaN(numValue) && numValue >= 2) return '2-3';

  return '1';
}

function tierOf(count) {
  if (count === '1')     return 'entry';
  if (count === '2-3')   return 'mid';
  return 'upper';
}

function getStorageTier(storageGb) {
  const storage = parseInt(storageGb) || 10;
  
  if (storage < 20) return STORAGE_TIER.SMALL;
  if (storage <= 50) return STORAGE_TIER.MEDIUM;
  return STORAGE_TIER.LARGE;
}

function detectKeywords(text) {
  if (!text || typeof text !== 'string') return null;
  
  const normalized = text.toLowerCase().trim();
  
  if (KEYWORD_MAPPINGS.windows.some(keyword => normalized.includes(keyword))) {
    return 'windows';
  }
  
  if (KEYWORD_MAPPINGS.ssl.some(keyword => normalized.includes(keyword))) {
    return 'ssl';
  }
  
  if (KEYWORD_MAPPINGS.ecommerce.some(keyword => normalized.includes(keyword))) {
    return 'ecommerce';
  }
  
  if (KEYWORD_MAPPINGS.business.some(keyword => normalized.includes(keyword))) {
    return 'business';
  }
  
  if (KEYWORD_MAPPINGS.wordpress.some(keyword => normalized.includes(keyword))) {
    return 'wordpress';
  }
  
  return null;
}
