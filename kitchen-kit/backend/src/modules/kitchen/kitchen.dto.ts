import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  Matches,
} from 'class-validator';

/**
 * Ids are ULIDs stored as UUID. `@IsUUID()` rejects them (ULID-as-UUID
 * carries no RFC-4122 version nibble) — same convention as `sales.dto.ts`.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** FR-KDS-023 — FIFO only in this slice (design gate §17). */
export class StationQueueQueryDto {
  @IsOptional()
  @IsIn(['fifo'])
  sort?: 'fifo';
}

/** `POST /kds/stations/{stationId}/tickets/view` — design gate §9. */
export class AcknowledgeViewedDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @Matches(UUID_PATTERN, { each: true })
  ticketIds!: string[];
}
