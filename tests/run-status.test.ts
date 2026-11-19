import { describe, expect, it } from 'vitest';
import { getRunStatusDetail } from '../src/lib/run-status';

const now = Date.UTC(2026, 10, 19, 17, 0, 0);

describe('monitor history explains status without overstating delivery', () => {
 it('shows the remaining callback window for a pending run', () => {
  expect(getRunStatusDetail({state:'pending',expires_at:now+10*60_000}, now))
   .toContain('10 minutes left');
  expect(getRunStatusDetail({state:'pending',expires_at:now+29_000}, now))
   .toContain('1 minute left');
 });
 it('distinguishes elapsed deadlines from completed timeout sweeps', () => {
  expect(getRunStatusDetail({state:'pending',expires_at:now-1}, now))
   .toContain('Waiting for the scheduled timeout sweep');
 });
 it('does not claim the original lead was lost if no callback arrives', () => {
  expect(getRunStatusDetail({state:'unconfirmed',expires_at:now-1}, now))
   .toContain('not proven lost');
 });
 it('explains independent confirmation and actual webhook rejection', () => {
  expect(getRunStatusDetail({state:'confirmed',expires_at:now}, now))
   .toContain('Authenticated destination callback');
  expect(getRunStatusDetail({state:'error',expires_at:now,response_status:503}, now))
   .toContain('HTTP 503');
 });
 it('handles missing data conservatively', () => {
  expect(getRunStatusDetail({state:'pending',expires_at:null},now))
   .toContain('Waiting for the destination callback');
  expect(getRunStatusDetail({state:'error',expires_at:now,response_status:null},now))
   .toContain('destination was not verified');
 });
});
