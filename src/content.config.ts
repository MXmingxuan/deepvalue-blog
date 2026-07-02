import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.date(),
    updated: z.date().optional(),
    description: z.string().optional(),
    summary: z.string().optional(),
    sector: z.enum(['chemical', 'ai-infrastructure', 'shipping-shipbuilding', 'energy', 'other']).default('other'),
    research_type: z.enum(['sector', 'company', 'event', 'memo']).default('memo'),
    status: z.enum(['draft', 'active', 'archived']).default('draft'),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
    tags: z.array(z.string()).default([]),
    categories: z.array(z.string()).default([]),
    companies: z.array(z.string()).default([]),
    tickers: z.array(z.string()).default([]),
    thesis: z.string().optional(),
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

export const collections = { blog, projects };
