/**
 * Workforce PUBLIC contract barrel — SRS §5.4.
 *
 * Other modules import `modules/workforce/contract` and nothing else. The
 * `module-boundaries.spec.ts` architecture test enforces that mechanically,
 * which is what SRS §5.2.3 requires of the rule.
 */
export * from './commands';
export * from './types';
export * from './attendance-summary.query';
export * from './scope-target.resolvers';
