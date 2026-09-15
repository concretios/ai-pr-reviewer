import type { Limits } from '../config.js';
export type Ticket = { id: number; reservation: number; settled: boolean; charged: number; unknown: boolean };
export class Budget {
  private tickets: Ticket[] = [];
  private closed = false;
  constructor(readonly limits: Limits) {}
  reserve(reservation = this.limits.input + this.limits.output): Ticket | undefined {
    if (!Number.isSafeInteger(reservation) || reservation <= 0) throw new Error('Invalid token reservation');
    if (this.closed || this.tickets.length >= this.limits.attempts || this.snapshot().charged + this.snapshot().reserved + reservation > this.limits.tokens) return undefined;
    const ticket = { id: this.tickets.length, reservation, settled: false, charged: 0, unknown: false };
    this.tickets.push(ticket); return ticket;
  }
  settle(ticket: Ticket, usage?: number): void {
    if (this.closed || ticket.settled) return;
    ticket.settled = true;
    ticket.unknown = usage === undefined || !Number.isFinite(usage) || usage < 0;
    ticket.charged = ticket.unknown ? ticket.reservation : usage!;
  }
  close(): void {
    for (const ticket of this.tickets) if (!ticket.settled) this.settle(ticket);
    this.closed = true;
  }
  snapshot(): { attempts: number; charged: number; reserved: number; unknown: number } {
    return { attempts: this.tickets.length, charged: this.tickets.reduce((sum, t) => sum + t.charged, 0),
      reserved: this.tickets.filter(t => !t.settled).reduce((sum, t) => sum + t.reservation, 0), unknown: this.tickets.filter(t => t.unknown).length };
  }
}

export class ExecutionEpoch {
  private open = true;
  readonly controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }
  isOpen(): boolean { return this.open && !this.signal.aborted; }
  close(reason = 'Execution finalized'): void {
    if (!this.open) return;
    this.open = false; this.controller.abort(new Error(reason));
  }
}
