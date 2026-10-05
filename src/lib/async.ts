// Preserve input order while bounding concurrent I/O.
export async function mapLimited<T, R>(items: T[], map: (item: T) => Promise<R>, limit = 6): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Concurrency must be a positive integer");
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
