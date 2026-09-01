import {
  isLineAlreadyBumped,
  projectTicketStatus,
  TicketLineProjectionFact,
} from './ticket-projection';

function line(
  status: TicketLineProjectionFact['status'],
  startedAt: Date | null = null,
): TicketLineProjectionFact {
  return { status, startedAt };
}

describe('projectTicketStatus (design gate §11/§16)', () => {
  it('queued when no line has ever started', () => {
    expect(projectTicketStatus([line('queued'), line('queued')])).toBe(
      'queued',
    );
  });

  it('in_progress when at least one line has startedAt, but not all lines are ready-or-beyond', () => {
    expect(
      projectTicketStatus([line('started', new Date()), line('queued')]),
    ).toBe('in_progress');
  });

  it('ready when every non-cancelled line is ready-or-beyond, even with no explicit start (bump direct from queued)', () => {
    expect(projectTicketStatus([line('ready'), line('ready')])).toBe('ready');
  });

  it('bumped when every non-cancelled line is bumped-or-beyond', () => {
    expect(projectTicketStatus([line('bumped'), line('served')])).toBe(
      'bumped',
    );
  });

  it('bumped is reachable directly from queued (bump skipping start entirely)', () => {
    expect(projectTicketStatus([line('bumped')])).toBe('bumped');
  });

  it('a cancelled line is excluded from the ready/bumped aggregate — remaining lines decide', () => {
    expect(projectTicketStatus([line('cancelled'), line('bumped')])).toBe(
      'bumped',
    );
    expect(projectTicketStatus([line('cancelled'), line('ready')])).toBe(
      'ready',
    );
  });

  it('an ALL-cancelled ticket must NOT become ready or bumped', () => {
    expect(projectTicketStatus([line('cancelled'), line('cancelled')])).toBe(
      'queued',
    );
    expect(
      projectTicketStatus([line('cancelled', new Date()), line('cancelled')]),
    ).toBe('in_progress');
  });

  it('mixed: one bumped, one still queued -> in_progress (not ready, not bumped)', () => {
    expect(
      projectTicketStatus([line('bumped', new Date()), line('queued')]),
    ).toBe('in_progress');
  });
});

describe('isLineAlreadyBumped', () => {
  it('true for bumped and served', () => {
    expect(isLineAlreadyBumped('bumped')).toBe(true);
    expect(isLineAlreadyBumped('served')).toBe(true);
  });

  it('false for queued, started, ready, cancelled', () => {
    expect(isLineAlreadyBumped('queued')).toBe(false);
    expect(isLineAlreadyBumped('started')).toBe(false);
    expect(isLineAlreadyBumped('ready')).toBe(false);
    expect(isLineAlreadyBumped('cancelled')).toBe(false);
  });
});
