import { fileURLToPath } from 'node:url';

import type { DocgenProviderDescriptor } from 'storybook/internal/types';

/**
 * Addon-docs docgen provider.
 *
 * Contributes a {@link DocgenProviderDescriptor} pointing at {@link ./docgen-worker.ts}, appended to
 * the accumulated array so it composes on top of the renderer's provider inside core's docgen worker.
 * The actual enrichment runs off the main thread; this preset only resolves the worker module path.
 */
export const experimental_docgenProvider = async (
  existing: DocgenProviderDescriptor[] = []
): Promise<DocgenProviderDescriptor[]> => [
  ...existing,
  {
    moduleSpecifier: fileURLToPath(
      import.meta.resolve('@storybook/addon-docs/internal/docgen-worker')
    ),
  },
];
