/**
 * Open-Meteo returns hourly data column-wise:
 *   { time: [t0, t1], wind_speed_10m: [5.1, 6.0] }
 * Agents (and our business logic) want row-wise records:
 *   [{ time: t0, wind_speed_10m: 5.1 }, { time: t1, wind_speed_10m: 6.0 }]
 */
export type Columns = { time: string[] } & Record<string, unknown>;

export function columnsToRows<K extends string>(
  columns: Columns,
  keys: readonly K[],
): Array<{ time: string } & Record<K, number | null>> {
  return columns.time.map((time, index) => {
    const row: Record<string, string | number | null> = { time };
    for (const key of keys) {
      const series = columns[key];
      const value = Array.isArray(series) ? series[index] : undefined;
      row[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    return row as { time: string } & Record<K, number | null>;
  });
}
