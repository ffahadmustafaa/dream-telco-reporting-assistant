/**
 * Lazily loads the xlsx spreadsheet library.
 *
 * xlsx is ~1MB minified and is only needed for Excel downloads, so it must
 * never be statically imported by a page — always go through this helper
 * from a click/download handler instead.
 */
export function loadXlsx(): Promise<typeof import("xlsx")> {
  return import("xlsx");
}
