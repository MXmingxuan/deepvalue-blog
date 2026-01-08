# Notes

This directory contains research notes, excerpts, and drafts that are NOT meant to be published directly to the blog.

## Usage
- You can store any Markdown files, images, or assets here.
- Hugo will **ignore** this folder during the build process, so these files will not appear on your public site.
- When you are ready to publish a note, you can use the `scripts/publish.sh` script to move it to the `content/posts/` directory and process it for publication:

```bash
# Example: Publishing a note to the blog
bash scripts/publish.sh notes/my-draft.md
```
