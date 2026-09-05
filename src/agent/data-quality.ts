/**
 * Classifies the data-quality state of a context bundle's data values.
 *
 * CONNECTOR_ERROR and NO_RESULTS are not the same:
 *   CONNECTOR_ERROR — the search did not actually happen successfully.
 *     The tool returned { error: "...", results: [] }. Infrastructure/
 *     data-quality failure.
 *   NO_RESULTS — the search completed and found nothing. The tool returned
 *     { results: [] } with no error field, or an empty array. Valid
 *     observation.
 *
 * Extracted to its own module so it can be unit-tested without pulling in
 * the runner's heavy dependency graph (database, providers, etc.).
 */
export function classifyDataQuality(data: Record<string, unknown>): {
  hasUsableData: boolean;
  allConnectorErrors: boolean;
} {
  const values = Object.values(data);
  const hasUsableData = values.some((v) => {
    if (v == null || v === "") return false;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      // Connector error: object with `error` field and empty/missing
      // `results` — the search did not succeed, this is not usable data.
      if (obj.error && (!obj.results || (Array.isArray(obj.results) && obj.results.length === 0))) {
        return false;
      }
      // Object with a `results` array that is empty — NO_RESULTS, not
      // usable data. The object may have metadata (query, etc.) but no
      // actual data rows.
      if (Array.isArray(obj.results) && obj.results.length === 0) {
        return false;
      }
      return Object.keys(obj).length > 0;
    }
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
  const allConnectorErrors = values.length > 0 && values.every((v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      return !!obj.error && (!obj.results || (Array.isArray(obj.results) && obj.results.length === 0));
    }
    return false;
  });
  return { hasUsableData, allConnectorErrors };
}
