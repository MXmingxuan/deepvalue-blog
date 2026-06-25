# Deep Value Content Ops

Local editorial operations tool for `D:\github\deepvalue-blog`.

## Run

```bash
npm run ops
```

Then open:

```text
http://localhost:4399
```

Use `CONTENT_OPS_PORT` to run on another port:

```powershell
$env:CONTENT_OPS_PORT='4499'; npm.cmd run ops
```

## Test

```bash
npm run ops:test
```

On Windows PowerShell, use `npm.cmd` if `npm.ps1` is blocked:

```powershell
npm.cmd run ops:test
```

## Runtime State

The tool writes local workflow state to:

```text
.content-ops/state.json
```

This directory is ignored by git.

## V1 Scope

- Scan blog and project Markdown.
- Edit frontmatter title and description plus Markdown body.
- Show publish-readiness checks.
- Run build and sync commands.
- Open long-form Markdown files in VS Code.

## Notes

- The embedded preview is a fast structural preview, not a pixel-perfect Astro render.
- The public Astro content schema remains unchanged.
- Workflow state and research hooks stay in local `.content-ops` state.
