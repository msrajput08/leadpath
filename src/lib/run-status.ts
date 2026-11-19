/** Human-friendly monitoring status text. No network, accounts, or assumptions about CRM delivery. */
export type RunStatusInput = {
 state: string;
 expires_at: number | null;
 response_status?: number | null;
};

export function getRunStatusDetail(run: RunStatusInput, time = Date.now()): string {
 if (run.state === 'confirmed') return 'Authenticated destination callback received for this run ID.';
 if (run.state === 'unconfirmed') return 'No matching callback arrived before the deadline. Delivery is unverified, not proven lost.';
 if (run.state === 'error') {
  if (run.response_status !== null && run.response_status !== undefined && run.response_status >= 400) {
   return `Webhook returned HTTP ${run.response_status}; check the Make execution history.`;
  }
  return 'The webhook request failed. The destination was not verified.';
 }
 if (run.state === 'pending') {
  if (!run.expires_at) return 'Waiting for the destination callback.';
  const remaining = run.expires_at - time;
  if (remaining <= 0) return 'Callback deadline passed. Waiting for the scheduled timeout sweep.';
  const minutes = Math.ceil(remaining / 60_000);
  return `Waiting for the destination callback · ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left.`;
 }
 return 'Status unavailable. Refresh the monitoring history.';
}
