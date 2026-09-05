/**
 * Platform PUBLIC contract barrel — SRS §5.4.
 *
 * Other modules import `modules/platform/contract` and nothing else;
 * `module-boundaries.spec.ts` enforces that mechanically.
 */
export * from './scheduled-job';
/**
 * The handler-registration decorator itself. A domain module cannot reach
 * `modules/platform/scheduler/...` (that is a private directory), so the
 * decorator is re-exported here — the same thin re-export pattern Sync uses for
 * `SyncOperationHandlerFor`. Its implementation is a one-line NestJS primitive
 * (`DiscoveryService.createDecorator`) with no behaviour of its own.
 */
export * from '../scheduler/scheduled-job-handler.decorator';
