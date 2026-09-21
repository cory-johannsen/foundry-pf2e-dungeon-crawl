import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    environment: 'node'
  },
  resolve: {
    alias: [
      {
        // Production code imports shared infra via the package-id-keyed
        // path Foundry actually uses at runtime (Data/modules/<id>/...).
        // Locally, sibling checkouts are named after their repo, not their
        // package id, so redirect that literal prefix to wherever this
        // repo's sibling checkout of deck-of-many-more-things actually
        // lives. Adjust the replacement path if your local clone differs.
        find: /^(\.\.\/)+deck-of-many-more-things\/scripts\//,
        replacement: path.resolve(dirname, '../foundry-deck-of-many-things/scripts/') + '/'
      }
    ]
  }
});
