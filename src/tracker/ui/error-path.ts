/** Convert REST validation paths into the fields used by tracker controls. */
export function trackerErrorField(path: string | undefined): string | null {
  if (!path) return null;
  const field = path.replace(/^patch\./, '').split(/[.[\]]/u, 1)[0];
  if (field === 'query') return 'search';
  if (field === 'assigneeId') return 'assignee';
  return field;
}
