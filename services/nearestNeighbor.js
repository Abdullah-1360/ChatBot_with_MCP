/**
 * Nearest Neighbor Finder Module
 * Finds best matching plans within the same GID using enhanced distance metrics
 */

const { calculateConfidence } = require('./confidenceScorer');

/**
 * Calculate Euclidean distance in normalized feature space
 * @param {Object} plan - WHMCS product object
 * @param {Object} requirements - User requirements
 * @param {number} maxStorage - Maximum storage in plan set
 * @param {number} maxPrice - Maximum price in plan set
 * @returns {number} Distance score (lower is better)
 */
function calculateDistance(plan, requirements, maxStorage, maxPrice) {
  // Normalize features to 0-1 range for fair comparison
  const planStorage = parseFloat(plan.diskspace) || 0;
  const planPrice = parseFloat(plan.pricing.USD.monthly) || 0;
  
  // Storage distance (normalized)
  const storageNorm = maxStorage > 0 ? planStorage / maxStorage : 0;
  const reqStorageNorm = maxStorage > 0 ? requirements.storage_needed_gb / maxStorage : 0;
  const storageDist = Math.abs(storageNorm - reqStorageNorm);
  
  // Price distance (normalized)
  const priceNorm = maxPrice > 0 ? planPrice / maxPrice : 0;
  const reqPriceNorm = maxPrice > 0 ? requirements.monthly_budget / maxPrice : 0;
  const priceDist = Math.abs(priceNorm - reqPriceNorm);
  
  // Feature distance (binary features)
  const domainDist = requirements.free_domain && !plan.freedomain ? 1 : 0;
  
  // Weighted Euclidean distance
  // Storage: 40%, Price: 40%, Domain: 20%
  const distance = Math.sqrt(
    Math.pow(storageDist * 0.4, 2) +
    Math.pow(priceDist * 0.4, 2) +
    Math.pow(domainDist * 0.2, 2)
  );
  
  return distance;
}

/**
 * Calculate diversity score for plan selection
 * Ensures recommended plans cover different price/feature ranges
 * @param {Array} selectedPlans - Already selected plans
 * @param {Object} candidatePlan - Plan being considered
 * @returns {number} Diversity bonus (0-10)
 */
function calculateDiversityBonus(selectedPlans, candidatePlan) {
  if (selectedPlans.length === 0) return 0;
  
  const candidatePrice = parseFloat(candidatePlan.pricing.USD.monthly);
  const candidateStorage = parseFloat(candidatePlan.diskspace);
  
  let minPriceDiff = Infinity;
  let minStorageDiff = Infinity;
  
  selectedPlans.forEach(selected => {
    const priceDiff = Math.abs(candidatePrice - parseFloat(selected.pricing.USD.monthly));
    const storageDiff = Math.abs(candidateStorage - parseFloat(selected.diskspace));
    
    minPriceDiff = Math.min(minPriceDiff, priceDiff);
    minStorageDiff = Math.min(minStorageDiff, storageDiff);
  });
  
  // Bonus for being different from already selected plans
  const diversityScore = (minPriceDiff / 10) + (minStorageDiff / 20);
  return Math.min(10, diversityScore);
}

/**
 * Find nearest neighbor plans within the same GID
 * Uses hybrid approach: confidence scoring + distance metrics + diversity
 * @param {Array} plans - Array of WHMCS product objects (all from same GID)
 * @param {Object} requirements - User requirements
 * @param {number} requirements.storage_needed_gb - Required storage
 * @param {number} requirements.monthly_budget - Monthly budget
 * @param {string} requirements.minTier - Minimum tier
 * @param {boolean} requirements.free_domain - Free domain needed
 * @returns {Array} Top 3 plans sorted by composite score
 */
function findNearestNeighbors(plans, requirements) {
  if (!plans || plans.length === 0) {
    return [];
  }
  
  // Early exit for impossible requirements
  try {
    const maxDisk = Math.max(...plans.map(p => parseFloat(p.diskspace) || 0));
    const minPrice = Math.min(...plans.map(p => parseFloat(p.pricing.USD.monthly) || Infinity));
    
    // Storage requirement is 10x+ beyond any plan in GID
    if (requirements.storage_needed_gb && maxDisk > 0 && requirements.storage_needed_gb > maxDisk * 10) {
      return [];
    }
    
    // Budget is less than 20% of cheapest plan (unrealistic)
    if (requirements.monthly_budget > 0 && minPrice > 0 && requirements.monthly_budget < minPrice * 0.2) {
      return [];
    }
  } catch (err) {
    // Continue with normal processing
  }
  
  // Calculate normalization factors
  const maxStorage = Math.max(...plans.map(p => parseFloat(p.diskspace) || 0));
  const maxPrice = Math.max(...plans.map(p => parseFloat(p.pricing.USD.monthly) || 0));
  
  // Calculate confidence and distance for all plans
  const plansWithScores = plans.map(plan => {
    const confidence = calculateConfidence(plan, requirements);
    const distance = calculateDistance(plan, requirements, maxStorage, maxPrice);
    const priceNum = parseFloat(plan.pricing.USD.monthly);
    
    // Composite score: 70% confidence + 30% proximity (inverse distance)
    // Distance is 0-1, so (1-distance) gives proximity
    const proximityScore = (1 - distance) * 30;
    const compositeScore = confidence * 0.7 + proximityScore;
    
    return {
      ...plan,
      confidence,
      distance,
      compositeScore,
      priceNum
    };
  });
  
  // IMPROVED: Prioritize plans closest to requirements
  // First, try to find plans with confidence > 50% (reasonable match)
  let viablePlans = plansWithScores.filter(p => p.confidence > 50);
  
  // If no good matches, lower threshold to 40%
  if (viablePlans.length === 0) {
    viablePlans = plansWithScores.filter(p => p.confidence > 40);
  }
  
  // If still no matches, use best available (minimum 30% confidence)
  if (viablePlans.length === 0) {
    viablePlans = plansWithScores.filter(p => p.confidence > 30);
  }
  
  // Last resort: return empty if all plans are below 30% confidence
  if (viablePlans.length === 0) {
    return [];
  }
  
  // Sort by confidence FIRST (prioritize better matches), then by composite score
  viablePlans.sort((a, b) => {
    // Confidence is the primary sort key
    const confDiff = b.confidence - a.confidence;
    if (Math.abs(confDiff) > 5) return confDiff;
    
    // For similar confidence, use composite score
    const scoreDiff = b.compositeScore - a.compositeScore;
    if (Math.abs(scoreDiff) > 1) return scoreDiff;
    
    // For similar scores, prefer lower price
    return a.priceNum - b.priceNum;
  });
  
  // Select top 3 with diversity consideration
  const selected = [viablePlans[0]];
  
  for (let i = 1; i < viablePlans.length && selected.length < 3; i++) {
    const candidate = viablePlans[i];
    const diversityBonus = calculateDiversityBonus(selected, candidate);
    candidate.finalScore = candidate.compositeScore + diversityBonus;
    
    // Add if score is competitive or provides good diversity
    if (selected.length < 3) {
      selected.push(candidate);
    }
  }
  
  // Re-sort by confidence for final output (user-facing metric)
  selected.sort((a, b) => {
    if (Math.abs(b.confidence - a.confidence) > 1) {
      return b.confidence - a.confidence;
    }
    return a.priceNum - b.priceNum;
  });
  
  // Clean up temporary fields
  selected.forEach(p => {
    delete p.priceNum;
    delete p.distance;
    delete p.compositeScore;
    delete p.finalScore;
  });
  
  return selected;
}

module.exports = {
  findNearestNeighbors,
  calculateDistance,
  calculateDiversityBonus
};
