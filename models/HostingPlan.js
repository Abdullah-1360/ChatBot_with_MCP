/**
 * HostingPlan Model for MongoDB (MCP Server)
 * Uses same schema as Product model but reads from products collection
 */

const mongoose = require('mongoose');

const hostingPlanSchema = new mongoose.Schema({
  pid: { type: String, required: true, unique: true },
  gid: { type: String, required: true },
  type: { type: String },
  name: { type: String, required: true },
  description: { type: String, required: true },
  module: { type: String },
  paytype: { type: String },
  diskspace: { type: String, required: true },
  freedomain: { type: Boolean, required: true },
  hidden: { type: Boolean, default: false },
  pricing: { type: mongoose.Schema.Types.Mixed, required: true },
  customfields: { type: mongoose.Schema.Types.Mixed },
  configoptions: { type: mongoose.Schema.Types.Mixed },
  link: { type: String, required: true }
}, {
  timestamps: true,
  collection: 'products', // Use same collection as main app
  strict: false
});

// Indexes for fast searches (same as Product model + additional for MCP)
hostingPlanSchema.index({ gid: 1 }); // Filter by group
hostingPlanSchema.index({ hidden: 1 }); // Filter hidden plans
hostingPlanSchema.index({ name: 'text', description: 'text' }); // Text search
hostingPlanSchema.index({ 'pricing.PKR.monthly': 1 }); // Budget filtering PKR
hostingPlanSchema.index({ 'pricing.USD.monthly': 1 }); // Budget filtering USD
hostingPlanSchema.index({ diskspace: 1 }); // Storage filtering
hostingPlanSchema.index({ name: 1 }); // Name lookups

module.exports = mongoose.model('HostingPlan', hostingPlanSchema);
