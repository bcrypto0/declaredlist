// The rules a scan result must meet to be built into the site. The build
// refuses a result that breaks them, and the scanner publishes no result the
// build would refuse, so a published scan is always one the site can show.

export const MAX_LISTINGS = 5000;

// What is wrong with a scan result, as a short phrase, or null when it can be
// built. A pass over updated listings may read no listing at all (nothing
// changed since the last scan) when it rests on a full pass that read some.
export function latestProblem(latest) {
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) return 'is missing or not an object';
  if (!Number.isFinite(Date.parse(latest.scanFinishedAt))) return 'has no scan time';
  if (!Array.isArray(latest.listings)) return 'has no listings array';
  const scanned = latest.counts && typeof latest.counts === 'object' ? latest.counts.listingsScanned : undefined;
  if (!Number.isInteger(scanned) || scanned < 0) return 'reports no scanned listings';
  if (scanned === 0) {
    const cov = latest.coverage && typeof latest.coverage === 'object' ? latest.coverage : null;
    const full = cov && cov.lastFullPass && typeof cov.lastFullPass === 'object' ? cov.lastFullPass : null;
    const restsOnFullPass = cov && cov.mode === 'updated_since' && full && Number.isInteger(full.listingsScanned) && full.listingsScanned > 0;
    if (!restsOnFullPass) return 'reports no scanned listings and rests on no full pass that read some';
  }
  if (latest.listings.length > MAX_LISTINGS) return `has more than ${MAX_LISTINGS} listings`;
  for (const r of latest.listings) if (!r || typeof r.name !== 'string' || r.name.length === 0) return 'has a listing without a name';
  return null;
}
