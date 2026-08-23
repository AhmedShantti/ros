import { DiscoveryService } from '@nestjs/core';

/**
 * Marks a provider class as a transactional handler for one event type.
 *
 * `@DomainEventHandler('order.line.fired') @Injectable() class Foo { handle(event, ctx) {...} }`
 * — declared as a normal provider in ITS OWN bounded-context module's
 * `providers` array. `DomainEventHandlerRegistry` (this directory) discovers
 * it at application bootstrap via `DiscoveryService`, which scans the WHOLE
 * Nest module graph, not just modules that import `DomainEventsModule`. That
 * is what satisfies §5.2.3/§5.4's boundary rules for registration:
 *
 *   - the publishing module (e.g. Sales) needs to know only the event
 *     CONTRACT (`modules/sales/contract/events.ts`), never the handler;
 *   - the subscribing module (e.g. Kitchen) keeps its handler PRIVATE — it is
 *     never exported, never imported by anyone;
 *   - `common/domain-events` never imports Sales or Kitchen — it only scans
 *     the container for a metadata key, which is how a new subscriber can be
 *     added without editing this infrastructure or `AppModule` at all.
 *
 * Built on `DiscoveryService.createDecorator`, the same officially supported
 * `@publicApi` mechanism `@nestjs/schedule`'s `@Cron` and similar
 * discovery-based decorators use — not a bespoke reflection scheme.
 */
export const DomainEventHandler = DiscoveryService.createDecorator<string>();
