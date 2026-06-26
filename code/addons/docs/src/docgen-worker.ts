/**
 * Worker-target docgen module for addon-docs.
 *
 * A small enrichment layer composed inside core's docgen worker: it wraps the renderer's provider
 * and appends a `(docs enabled)` marker to the resulting description so consumers can tell addon-docs
 * participated. It produces no docgen on its own — when the rest of the chain returns nothing it
 * passes that through unchanged.
 */
import type { DocgenMiddleware, DocgenProvider } from 'storybook/internal/types';

export const createDocgenProvider = (): DocgenMiddleware => {
  return (nextDocgen: DocgenProvider): DocgenProvider =>
    async (input) => {
      const downstream = await nextDocgen(input);
      if (!downstream) {
        return undefined;
      }
      return {
        ...downstream,
        description: downstream.description
          ? `${downstream.description} (docs enabled)`
          : 'docs enabled',
      };
    };
};
