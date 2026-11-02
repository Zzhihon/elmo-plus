#!/usr/bin/env tsx

/**
 * Regenerates src/routeTree.gen.ts without starting Vite, using the configuration
 * the TanStack Start plugin applies during a build. The footer is written out here
 * because the plugin derives it from its own resolved state.
 */
import { fileURLToPath } from "node:url";
import { Generator, getConfig } from "@tanstack/router-generator";

const root = fileURLToPath(new URL("..", import.meta.url));

const footer = `import type { getRouter } from './router.tsx'
import type { startInstance } from './start.ts'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
    config: Awaited<ReturnType<typeof startInstance.getOptions>>
  }
}`;

const config = getConfig(
	{
		target: "react",
		routesDirectory: "./src/routes",
		generatedRouteTree: "./src/routeTree.gen.ts",
		routeTreeFileFooter: [footer],
	},
	root,
);

await new Generator({ config, root }).run();
