import process from 'node:process';

const message = `prepare:publish is deprecated and has been disabled for safety.

It previously edited Markdown and moved attachments out of their source folders.
The replacement publisher treats a separate Obsidian Vault as read-only and copies
only explicitly publishable content after an isolated preview.

Migration:
  1. Copy publish.config.example.json to publish.config.local.json and set vaultRoot.
  2. Add the YAML boolean "publish: true" and a stable "publish_id" to the note.
  3. Publish the active note with:
       npm run publish:current -- --source "/absolute/path/to/note.md"
     Or review every eligible changed note with:
       npm run publish:pending

Nothing was changed or moved.`;

process.stderr.write(`${message}\n`);
process.exitCode = 2;
