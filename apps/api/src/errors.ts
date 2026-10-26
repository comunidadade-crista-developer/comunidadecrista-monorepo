export function isUniqueViolation(err: unknown): err is { code: '23505' } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}