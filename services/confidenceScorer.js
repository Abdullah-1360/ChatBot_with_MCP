/**
 * Confidence Scorer Module
 * Calculates confidence scores for plan recommendations based on weighted criteria
 */

const { getTierFromPlan, getTierRank } = require('../utils/tierHelper');

function scoreStorage(planStorage, requiredStorage) {
  if (planStorage >= requiredStorage) {
    if (planStorage === requiredStorage) return 40;
    
    const excessRatio = planStorage / requiredStorage;
    
    if (excessRatio <= 1.5) return 38;
    if (excessRatio <= 2.0) return 35;
    if (excessRatio <= 3.0) return 30;
    if (excessRatio <= 5.0) return 25;
    
    return Math.max(15, 40 - Math.log2(excessRatio) * 8);
  }
  
  const ratio = planStorage / requiredStorage;
  
  if (ratio >= 0.9) return 35 + (ratio - 0.9) * 50;
  if (ratio >= 0.8) return 28 + (ratio - 0.8) * 70;
  if (ratio >= 0.6) return 18 + (ratio - 0.6) * 50;
  if (ratio >= 0.4) return 10 + (ratio - 0.4) * 40;
  if (ratio >= 0.2) return 5 + (ratio - 0.2) * 25;
  
  return ratio * 25;
}

function scoreBudget(planPrice, budget) {
  if (budget === 0) {
    return planPrice <= 5 ? 30 : Math.max(0, 30 - planPrice * 2);
  }
  
  if (planPrice <= budget) {
    const utilizationRatio = planPrice / budget;
    
    if (utilizationRatio >= 0.7 && utilizationRatio <= 0.9) {
      return 28 + (0.9 - Math.abs(utilizationRatio - 0.8)) * 10;
    }
    
    if (utilizationRatio >= 0.95) return 27;
    if (utilizationRatio < 0.5) return 22 + utilizationRatio * 10;
    
    return 24 + (utilizationRatio - 0.5) * 10;
  }
  
  const overRatio = (planPrice - budget) / budget;
  
  if (overRatio <= 0.1) return 25;
  if (overRatio <= 0.25) return 20 - (overRatio - 0.1) * 33;
  if (overRatio <= 0.5) return 10 - (overRatio - 0.25) * 40;
  return 0;
}

function scoreTier(plan, minTier) {
  const planTier = getTierFromPlan(plan);
  const planRank = getTierRank(planTier);
  const minRank = getTierRank(minTier);
  
  if (planRank >= minRank) {
    if (planRank === minRank) return 40;
    if (planRank === minRank + 1) return 38;
    if (planRank === minRank + 2) return 32;
    
    const tierDiff = planRank - minRank;
    return Math.max(20, 40 - (tierDiff * 8));
  }
  
  const tierDiff = minRank - planRank;
  
  if (tierDiff === 1) return 15;
  
  return Math.max(0, 15 - (tierDiff - 1) * 10);
}

function scoreFreeDomain(plan, freeDomainNeeded) {
  if (!freeDomainNeeded) return 20;
  
  return plan.freedomain ? 20 : 0;
}

function calculateConfidence(plan, requirements) {
  try {
    const planStorage = parseFloat(plan.diskspace);
    
    const storageScore = scoreStorage(planStorage, requirements.storage_needed_gb);
    const tierScore = scoreTier(plan, requirements.minTier);
    const domainScore = scoreFreeDomain(plan, requirements.free_domain);
    
    const totalScore = storageScore + tierScore + domainScore;
    
    return Math.max(0, Math.min(100, Math.round(totalScore * 100) / 100));
  } catch (error) {
    console.error('Error calculating confidence:', error);
    return 0;
  }
}

module.exports = {
  scoreStorage,
  scoreBudget,
  scoreTier,
  scoreFreeDomain,
  calculateConfidence
};
