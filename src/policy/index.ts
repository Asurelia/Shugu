/**
 * Layer 4 — Policy: barrel export
 */

export { getToolCategory, getDefaultDecision, MODE_DESCRIPTIONS, type ToolCategory, type PermissionDecision } from './modes.js';
export { evaluateRules, ruleMatches, BUILTIN_RULES, type PermissionRule } from './rules.js';
export { PermissionResolver, type PermissionResult } from './permissions.js';
export { classifyBashRisk, type RiskLevel, type RiskClassification } from './classifier.js';
