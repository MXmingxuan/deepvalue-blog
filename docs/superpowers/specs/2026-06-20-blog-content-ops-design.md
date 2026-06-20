# Deep Value Blog Content Ops Design

Date: 2026-06-20
Project: `D:\github\deepvalue-blog`
Status: design approved for planning

## 1. Product Brief

Build a local Web App for managing the Deep Value Astro blog as an editorial operations workspace.

The tool runs on the user's computer, reads and writes Markdown files inside the blog repository, and keeps the current static-site publishing model intact. It should improve the existing workflow:

1. write a Markdown article,
2. put it in the correct content folder,
3. check metadata and preview,
4. run build/sync commands.

The first version is a publishing center, not a full research database. It should still leave clear hooks for future research-library features such as topics, companies, sources, and evidence.

## 2. Product Direction

Chosen direction: **Editorial Ops 工作台**.

The first screen is a high-density operational dashboard for managing many articles, not a blank writing surface. The tool should answer these questions quickly:

- 哪些文章是草稿？
- 哪些文章缺 frontmatter？
- 哪些文章可以发布？
- 最近一次构建是否通过？
- 哪篇文章需要补描述、日期、标签或分类？
- 长文应该在哪个外部编辑器中继续写？

The UI language should be mostly Chinese because the tool is for daily personal use. English is acceptable for product naming, commands, file paths, and technical labels such as `frontmatter`, `build`, `sync`, and `slug`.

## 3. First-Version Scope

### In Scope

- Scan `src/content/blog/*.md` and `src/content/projects/*.md`.
- Parse Markdown frontmatter according to the current Astro schema.
- Show content in pipeline states: 收件箱, 草稿, 待检查, 可发布, 已发布, 归档.
- Create new posts from templates.
- Import existing Markdown into a managed inbox.
- Edit metadata in structured fields.
- Provide an embedded Markdown editor for quick edits.
- Provide a rendered preview for fast structure checks.
- Open the Markdown file in an external editor for long-form writing.
- Run publishing checks before build/sync.
- Run existing commands such as `npm run build` and `npm run sync`.
- Show recent command logs and build status.
- Maintain tool-only state in a separate local index file.
- Add research-library hooks through metadata fields such as topic, company, ticker, source, and thesis.

### Out of Scope For V1

- Multi-user editing.
- Cloud CMS hosting.
- Authentication.
- Remote database.
- Full evidence graph.
- Citation manager.
- Automatic research writing.
- GitHub Pages deployment redesign.
- Replacing Astro's content model.
- Replacing the user's preferred long-form editor.

## 4. Information Architecture

### Primary Navigation

- 全部内容
- 收件箱
- 草稿
- 待检查
- 可发布
- 已发布
- 归档

### Future Research Entries

These should appear as secondary navigation or disabled/low-emphasis entries in V1:

- 主题
- 公司
- 素材来源

They are not full modules in V1. They exist to make the future direction visible and to justify the metadata fields added now.

## 5. Core Screens

### 5.1 文章工作台

Purpose: scan the whole content library and show publishing readiness.

Layout:

- Top bar: product name, global search, 导入, 新建文章.
- Left sidebar: pipeline filters and future research entries.
- Main table: article/project list.
- Right inspector: site health, publish checklist, recent build/sync status.

Main table columns:

- 标题
- 状态
- 日期
- 标签
- 检查

Useful row details:

- file path
- content type: blog or project
- frontmatter health
- whether the item appears in the public collection
- last modified time if available

### 5.2 文章详情页

Purpose: process one article from draft to publishable content.

Layout:

- Top actions: 返回工作台, 外部编辑器打开, 本地预览, 保存.
- Tabs: 编辑, 预览, 检查, 历史.
- Main area: split Markdown editor and preview.
- Right sidebar: metadata, validation results, article actions.

Metadata fields:

- title
- date
- description
- tags
- categories
- status
- topic
- company
- ticker
- source
- thesis

Actions:

- 保存
- 补描述
- 打开原文
- 查看页面
- 加入发布队列
- 标记可发布

### 5.3 发布检查页

Purpose: make the final pre-publish workflow explicit.

Checks:

- all required schema fields exist
- dates parse correctly
- tags and categories are arrays
- filename and slug are valid
- Markdown body is non-empty
- no accidental draft-only status is marked publishable
- `npm run build` passes
- sync command has been run when requested

### 5.4 命令日志页

Purpose: make build/sync failures understandable.

The tool should store recent command runs with:

- command
- start time
- end time
- exit code
- stdout/stderr
- derived status: running, passed, failed

## 6. Data Model

### Public Astro Frontmatter

The tool must preserve compatibility with the current blog schema:

```ts
{
  title: string;
  date: Date;
  description?: string;
  tags?: string[];
  categories?: string[];
}
```

For project files, it should preserve the current project schema:

```ts
{
  title: string;
  description: string;
  tech?: string[];
  status?: string;
  link?: string;
}
```

### Tool-Only Index

The tool should store operational metadata outside public content frontmatter where possible.

Recommended location:

```text
.content-ops/state.json
```

Recommended shape:

```json
{
  "items": {
    "src/content/blog/example.md": {
      "workflowStatus": "draft",
      "contentType": "blog",
      "topic": "轮胎产业链",
      "companies": ["赛轮轮胎", "森麒麟"],
      "tickers": [],
      "sources": ["公告", "行业数据"],
      "thesis": "涨价需要拆成需求、原料、库存和竞争格局四层看",
      "lastCheckedAt": "2026-06-20T00:00:00+08:00"
    }
  },
  "commands": []
}
```

Rationale: workflow status and research hooks are useful to the local tool but should not force public Astro content schema changes in V1.

## 7. Architecture

### Web App Frontend

Responsibilities:

- render dashboard, article detail, checks, and command logs
- provide filtering, sorting, search, and form editing
- call local API endpoints
- never run shell commands directly from UI code

### Local API Server

Responsibilities:

- expose endpoints for content listing, reading, saving, validation, and commands
- validate all requested file paths are inside the blog repository
- normalize filesystem and command errors
- serialize writes to avoid concurrent save conflicts

Suggested endpoint groups:

- `GET /api/content`
- `GET /api/content/:id`
- `POST /api/content`
- `PUT /api/content/:id`
- `POST /api/content/:id/open-external`
- `POST /api/checks/run`
- `POST /api/commands/build`
- `POST /api/commands/sync`
- `GET /api/commands`

### Content Adapter

Responsibilities:

- scan Markdown files
- parse frontmatter with a structured parser
- write Markdown while preserving body content
- infer workflow status from index state and validation results
- produce stable content ids from relative paths

### Command Runner

Responsibilities:

- run `npm run build` and `npm run sync`
- optionally start or check Astro preview later
- capture stdout/stderr
- stream command state to the UI
- persist recent command logs

## 8. Interaction Details

### New Post Flow

1. User clicks 新建文章.
2. Tool asks for content type: 博客 or 项目.
3. Tool asks for title, date, tags, categories, and optional topic/company/source.
4. Tool creates a Markdown file from a template.
5. Tool opens the article detail page in 草稿 status.

### Import Flow

1. User clicks 导入.
2. Tool receives a Markdown file path or pasted content.
3. Tool places the item into 收件箱.
4. Tool extracts or asks for missing frontmatter.
5. User moves it to 草稿 or 待检查.

### Ready-To-Publish Flow

1. User opens 待检查.
2. Tool shows missing metadata and build risks.
3. User fixes metadata/body.
4. Tool marks item 可发布.
5. User runs build.
6. If build passes, user can run sync.

## 9. Visual Design

The visual style should match the current Deep Value blog:

- black background
- white primary text
- silver secondary text and borders
- restrained green/amber/red status indicators
- mono typography for labels, commands, status, and paths
- Chinese labels for navigation and daily workflow actions
- dense table-based layout for scanning many articles
- no marketing hero page
- no decorative gradient/orb background
- no card-heavy landing page

Cards should only frame repeated modules, inspectors, or tool panels. Main page sections should stay functional and compact.

## 10. Error Handling

The tool should handle:

- malformed frontmatter
- unsupported date values
- missing required fields
- duplicate filenames
- failed file writes
- file changed outside the tool
- build command failure
- sync command failure
- external editor launch failure

For destructive actions such as delete, rename, or overwrite, the tool must ask for explicit confirmation and show the target path.

## 11. Testing Strategy

Unit tests:

- frontmatter parsing
- frontmatter writing
- content status inference
- relative path to content id mapping
- validation rules

Integration tests:

- scan content folders
- create a new Markdown file from template
- save metadata changes
- preserve body content during metadata edits
- run command runner with a mocked command
- handle build failure output

Manual verification:

- dashboard loads existing articles
- Chinese labels render correctly
- long Chinese titles do not overflow table rows
- article detail page can save and reopen content
- build/sync logs are visible

## 12. Open Implementation Decisions

These should be decided during implementation planning:

- whether the first implementation is a small Astro admin app plus Node server, or a separate Vite/React app plus Node server
- which Markdown editor component to use
- which external editor commands to support first, likely VS Code before Obsidian
- whether `.content-ops/state.json` should be committed or gitignored
- whether command logs should be stored in `.content-ops/logs/` or inside `state.json`

## 13. Approval Summary

Decisions approved in brainstorming:

- local workstation app, not hosted CMS
- mixed editing mode
- first version as publishing center, not full research database
- main product shape: Editorial Ops 工作台
- mostly Chinese daily UI labels
- dashboard + article detail + checks + command logs
- separate local API, content adapter, and command runner
- future research-library hooks through metadata fields
