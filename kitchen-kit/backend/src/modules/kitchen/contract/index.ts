/**
 * Kitchen Ops PUBLIC contract barrel — SRS §5.4.
 *
 * Only `events.ts` exists: Kitchen Ops has no other executable surface yet.
 * `module-boundaries.spec.ts` treats `kitchen` as a module the moment any file
 * exists under `modules/kitchen/`, so the same mechanical enforcement §5.2.3
 * requires applies to this contract even though nothing implements it.
 */
export * from './events';
