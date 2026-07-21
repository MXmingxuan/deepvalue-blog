import { getCollection } from 'astro:content';
import { selectPublished } from './entry-utils.mjs';

export async function getPublishedEntries(filters = {}) {
  const entries = await getCollection('entries');
  return selectPublished(entries, filters);
}
