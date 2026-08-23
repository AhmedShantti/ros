/**
 * Sales PUBLIC contract barrel — SRS §5.4.
 *
 * Only `events.ts` exists in this slice: no command/query/type crosses the
 * Sales boundary yet. `module-boundaries.spec.ts` is the mechanical
 * enforcement §5.2.3 requires — every other module may import
 * `modules/sales/contract` and nothing under `modules/sales/orders/`.
 */
export * from './events';
