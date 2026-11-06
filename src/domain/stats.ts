import { round } from "./units.js";

export const present = <T>(values: readonly (T | null | undefined)[]): T[] =>
  values.filter((value): value is T => value !== null && value !== undefined);

export function mean(values: readonly (number | null)[], digits = 1): number | null {
  const nums = present(values);
  return nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length, digits) : null;
}

export function max(values: readonly (number | null)[]): number | null {
  const nums = present(values);
  return nums.length ? Math.max(...nums) : null;
}

export function min(values: readonly (number | null)[]): number | null {
  const nums = present(values);
  return nums.length ? Math.min(...nums) : null;
}

export function sum(values: readonly (number | null)[], digits = 1): number | null {
  const nums = present(values);
  return nums.length ? round(nums.reduce((a, b) => a + b, 0), digits) : null;
}

export function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
