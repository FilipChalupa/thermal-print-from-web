import { tmpdir } from 'os'
import { join } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	// Source uses NodeNext `.js` import specifiers; map them to the `.ts` sources
	// so tests run against source without a build step.
	resolve: {
		alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1.ts' }],
	},
	test: {
		environment: 'node',
		// Several suites bind a mock printer on the fixed port 9100, so run test
		// files sequentially rather than in parallel workers.
		fileParallelism: false,
		// Keep config writes out of the real home directory.
		env: { THERMAL_CONFIG_PATH: join(tmpdir(), `thermal-vitest-${process.pid}.json`) },
	},
})
