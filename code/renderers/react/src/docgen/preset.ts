import { fileURLToPath } from 'node:url';

import type { DocgenProviderDescriptor } from 'storybook/internal/types';

/**
 * React renderer docgen provider.
 *
 * Contributes a {@link DocgenProviderDescriptor} pointing at {@link ./docgen-worker.ts}, which
 * core's docgen worker imports and runs off the main thread. The renderer owns no threading code —
 * it only resolves the worker module path. No `config` is sent: `react-component-meta` extraction
 * reads nothing from the user's `typescript` options (see {@link ./docgen-worker.ts}), so there is
 * nothing to serialize across the worker boundary.
 *
 * The descriptor is appended to the accumulated array so addon providers can stack on top, mirroring
 * the previous middleware chain — just composed inside the worker instead of in this process.
 */
export const experimental_docgenProvider = async (
  existing: DocgenProviderDescriptor[] = []
): Promise<DocgenProviderDescriptor[]> => [
  ...existing,
  {
    moduleSpecifier: fileURLToPath(import.meta.resolve('@storybook/react/internal/docgen-worker')),
  },
];
