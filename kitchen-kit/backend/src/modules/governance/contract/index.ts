/**
 * Governance PUBLIC contract barrel — SRS §5.4.
 *
 * Other modules import `modules/governance/contract` and nothing else.
 * `module-boundaries.spec.ts` enforces that mechanically, which is what SRS
 * §5.2.3 requires of the rule.
 */
export * from './approval.contract';
export * from './approval.errors';
export * from './audit';
