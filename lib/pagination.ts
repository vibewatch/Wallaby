const MAX_QUERY_OFFSET = 2_147_483_647;

export function positiveInteger(value: string | null | undefined, fallback: number): number {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export function pageNumber(value: string | null | undefined, pageSize: number): number {
  const page = positiveInteger(value, 1);
  return page - 1 <= Math.floor(MAX_QUERY_OFFSET / pageSize) ? page : 1;
}
