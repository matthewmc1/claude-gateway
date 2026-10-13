// Windowing for long lists: draw the first PAGE rows, reveal more on request. Search and sort always run over the full list.
export const PAGE = 60;
export function pageWindow(total: number, shown: number, step = PAGE): { count: number; left: number; next: number } {
  const count = Math.max(0, Math.min(total, Math.floor(shown) || 0)), left = total - count;
  return { count, left, next: Math.min(total, count + step) };
}
