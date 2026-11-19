-- Existing confirmed runs are proof of the integrated Make -> Google Sheets -> callback flow.
-- New monitors must echo a server-only challenge through Make before scheduled checks begin.
ALTER TABLE monitors ADD COLUMN verified_at INTEGER;

UPDATE monitors
SET verified_at = (
  SELECT MAX(r.confirmed_at) FROM runs r
  WHERE r.monitor_id=monitors.id AND r.state='confirmed'
)
WHERE EXISTS(
  SELECT 1 FROM runs r
  WHERE r.monitor_id=monitors.id AND r.state='confirmed'
);
