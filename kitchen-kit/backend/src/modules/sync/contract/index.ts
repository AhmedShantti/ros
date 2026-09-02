/**
 * Sync PUBLIC contract barrel — SRS §5.4.
 *
 * Other modules import `modules/sync/contract` and nothing else;
 * `module-boundaries.spec.ts` enforces that mechanically.
 */
export * from './sync-operation-handler';
export * from './sync-authorization.port';
