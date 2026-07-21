export function isPublished(entry) {
  return entry?.data?.status === 'published';
}

export function entryTimestamp(entry) {
  const value = entry.data.updated_at ?? entry.data.published_at;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function sortEntriesNewestFirst(entries) {
  return [...entries].sort((left, right) => entryTimestamp(right) - entryTimestamp(left));
}

export function selectPublished(entries, filters = {}) {
  const selected = entries.filter(entry => {
    if (!isPublished(entry)) return false;
    if (filters.domain && entry.data.domain !== filters.domain) return false;
    if (filters.section && entry.data.section !== filters.section) return false;
    if (filters.topic && entry.data.topic !== filters.topic) return false;
    if (filters.format && entry.data.format !== filters.format) return false;
    return true;
  });

  return sortEntriesNewestFirst(selected);
}
