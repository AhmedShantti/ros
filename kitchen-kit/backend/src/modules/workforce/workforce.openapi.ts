/**
 * OpenAPI response schema fragments for Workforce — plain interfaces (erased
 * at compile time) back every response here, so the `@nestjs/swagger` CLI
 * plugin cannot infer them; see `common/openapi/schema-helpers.ts`'s own
 * docblock for why this file exists at all.
 */
import {
  SchemaObject,
  isoDateTimeSchema,
  moneyStringSchema,
  nullable,
  uuidSchema,
} from '../../common/openapi/schema-helpers';

const EMPLOYMENT_TYPE_ENUM = [
  'full_time',
  'part_time',
  'casual',
  'contractor',
  'trainee',
];

export const employeeSchema: SchemaObject = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    code: { type: 'string' },
    displayName: { type: 'string' },
    namesLocalized: {
      type: 'object',
      description: 'Locale -> localised name, e.g. {"en": "...", "ar": "..."}.',
    },
    nationalId: nullable({ type: 'string' }),
    contactDetails: nullable({
      type: 'object',
      description: '{ phone?, email?, address? }',
    }),
    emergencyContact: nullable({
      type: 'object',
      description: '{ name?, phone?, relation? }',
    }),
    dateOfBirth: nullable({ type: 'string', format: 'date' }),
    hireDate: nullable({ type: 'string', format: 'date' }),
    terminationDate: nullable({ type: 'string', format: 'date' }),
    position: nullable({ type: 'string' }),
    department: nullable({ type: 'string' }),
    employmentType: nullable({ type: 'string', enum: EMPLOYMENT_TYPE_ENUM }),
    homeBranchId: uuidSchema(),
    status: { type: 'string', enum: ['active', 'suspended', 'terminated'] },
    userId: nullable(uuidSchema()),
    createdAt: isoDateTimeSchema(),
    updatedAt: isoDateTimeSchema(),
    branches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { branchId: uuidSchema() },
      },
    },
  },
};

export const compensationSchema: SchemaObject = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    employeeId: uuidSchema(),
    basis: { type: 'string', enum: ['hourly', 'monthly_salary', 'per_shift'] },
    amountMinorUnits: moneyStringSchema(),
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    effectiveFrom: isoDateTimeSchema(),
    createdBy: uuidSchema(),
    createdAt: isoDateTimeSchema(),
  },
};

export const scheduledShiftSchema: SchemaObject = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    branchId: uuidSchema(),
    scheduleId: uuidSchema(),
    employeeId: uuidSchema(),
    position: nullable({ type: 'string' }),
    startsAt: isoDateTimeSchema(),
    endsAt: isoDateTimeSchema(),
    createdBy: uuidSchema(),
    createdAt: isoDateTimeSchema(),
  },
};

export const scheduleSchema: SchemaObject = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    branchId: uuidSchema(),
    weekStartDate: { type: 'string', format: 'date' },
    createdBy: uuidSchema(),
    createdAt: isoDateTimeSchema(),
  },
};

export const scheduleWithShiftsSchema: SchemaObject = {
  type: 'object',
  properties: {
    ...scheduleSchema.properties,
    shifts: { type: 'array', items: scheduledShiftSchema },
  },
};

export const attendanceRecordSchema: SchemaObject = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    branchId: uuidSchema(),
    employeeId: uuidSchema(),
    scheduledShiftId: nullable(uuidSchema()),
    status: { type: 'string', enum: ['open', 'closed'] },
    clockInAt: isoDateTimeSchema(),
    clockOutAt: nullable(isoDateTimeSchema()),
    lateArrival: { type: 'boolean' },
    earlyDeparture: { type: 'boolean' },
    missingClockOut: { type: 'boolean' },
    outsideGeofence: { type: 'boolean' },
    unscheduled: { type: 'boolean' },
    createdAt: isoDateTimeSchema(),
  },
};

const clockEventSchema: SchemaObject = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    branchId: uuidSchema(),
    employeeId: uuidSchema(),
    attendanceRecordId: uuidSchema(),
    eventType: { type: 'string', enum: ['clock_in', 'clock_out'] },
    method: { type: 'string', enum: ['pos_pin', 'mobile', 'biometric'] },
    terminalId: nullable(uuidSchema()),
    deviceId: nullable({ type: 'string' }),
    gpsLat: nullable({ type: 'string' }),
    gpsLng: nullable({ type: 'string' }),
    occurredAt: isoDateTimeSchema(),
  },
};

export const attendanceCorrectionSchema: SchemaObject = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    branchId: uuidSchema(),
    employeeId: uuidSchema(),
    attendanceRecordId: uuidSchema(),
    field: { type: 'string', enum: ['clock_in_at', 'clock_out_at'] },
    originalValue: nullable(isoDateTimeSchema()),
    correctedValue: isoDateTimeSchema(),
    reason: { type: 'string' },
    actorId: uuidSchema(),
    createdAt: isoDateTimeSchema(),
  },
};

export const attendanceRecordWithHistorySchema: SchemaObject = {
  type: 'object',
  properties: {
    ...attendanceRecordSchema.properties,
    clockEvents: { type: 'array', items: clockEventSchema },
    corrections: { type: 'array', items: attendanceCorrectionSchema },
  },
};

export const attendanceSettingsSchema: SchemaObject = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    branchId: uuidSchema(),
    effectiveFrom: isoDateTimeSchema(),
    graceMinutes: nullable({ type: 'integer' }),
    earlyClockInMinutes: nullable({ type: 'integer' }),
    geofenceCenterLat: nullable({ type: 'string' }),
    geofenceCenterLng: nullable({ type: 'string' }),
    geofenceRadiusMeters: nullable({ type: 'integer' }),
    createdBy: uuidSchema(),
    createdAt: isoDateTimeSchema(),
  },
};

const employeeBranchRowSchema: SchemaObject = {
  type: 'object',
  properties: {
    tenantId: uuidSchema(),
    employeeId: uuidSchema(),
    branchId: uuidSchema(),
    createdAt: isoDateTimeSchema(),
  },
};

export const employeeBranchSchema = employeeBranchRowSchema;
