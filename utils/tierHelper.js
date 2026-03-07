/**
 * Tier Helper Utility Module
 * Provides tier extraction and comparison functions for hosting plans
 */

/**
 * Get tier from plan name
 * @param {Object} product - WHMCS product object
 * @returns {string} Tier (entry/mid/upper)
 */
function getTierFromPlan(product) {
  const name = product.name.toLowerCase();
  if (name.includes('starter') || name.includes('lite') || name.includes('basic')) {
    return 'entry';
  }
  if (name.includes('plus') || name.includes('standard')) {
    return 'mid';
  }
  return 'upper'; // pro, advanced, ultimate, enterprise, etc.
}

/**
 * Get tier rank for comparison
 * @param {string} tier - Tier name (entry/mid/upper)
 * @returns {number} Rank (1-3)
 */
function getTierRank(tier) {
  const tierRank = {
    entry: 1,
    mid: 2,
    upper: 3
  };
  return tierRank[tier] || 0;
}

/**
 * Compare two tiers
 * @param {string} tier1 - First tier
 * @param {string} tier2 - Second tier
 * @returns {number} -1 if tier1 < tier2, 0 if equal, 1 if tier1 > tier2
 */
function compareTiers(tier1, tier2) {
  const rank1 = getTierRank(tier1);
  const rank2 = getTierRank(tier2);
  
  if (rank1 < rank2) return -1;
  if (rank1 > rank2) return 1;
  return 0;
}

module.exports = {
  getTierFromPlan,
  getTierRank,
  compareTiers
};
