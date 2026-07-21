import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const domain = z.enum(['investment', 'ai', 'beyond']);
const format = z.enum(['article', 'log']);
const status = z.enum(['draft', 'published', 'archived']);
const sourceType = z.enum(['original', 'book', 'podcast', 'report', 'news', 'mixed']);

const entries = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/entries' }),
  schema: z.object({
    title: z.string(),
    publish_id: z.string().regex(/^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u),
    domain,
    section: z.string().optional(),
    topic: z.string().optional(),
    format,
    status,
    published_at: z.date(),
    updated_at: z.date().optional(),
    summary: z.string().optional(),
    source_type: sourceType.default('original'),
    source_title: z.string().optional(),
    source_url: z.string().url().optional(),
    tags: z.array(z.string()).default([]),
    commodities: z.array(z.string()).default([]),
    companies: z.array(z.string()).default([]),
    tickers: z.array(z.string()).default([]),
    thesis: z.string().optional(),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
  }).superRefine((entry, context) => {
    if (entry.format === 'article' && !entry.section) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['section'],
        message: 'Published article metadata requires section',
      });
    }
    if (entry.format === 'article' && !entry.summary) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'Published article metadata requires summary',
      });
    }
  }),
});

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    tech: z.array(z.string()).optional(),
    status: z.string().optional(),
    link: z.string().optional(),
  }),
});

export const collections = { entries, projects };
