/** @type {import("snowpack").SnowpackUserConfig } */
module.exports = {
    exclude: [
	'**/node_modules/**/*',
	'#*',
	'*~'
    ],
    mount: {
	"src": "/dist",
	"public": {url: "/", static: true, resolve: false}
    },
    plugins: [
	"@snowpack/plugin-svelte",
	"@snowpack/plugin-postcss"
    ],
    routes: [
	/* Enable an SPA Fallback in development: */
	// {"match": "routes", "src": ".*", "dest": "/index.html"},
    ],
    optimize: {
	/* Example: Bundle your final build: */
	// "bundle": true,
    },
    packageOptions: {
	/* ... */
    },
    devOptions: {
	tailwindConfig: './tailwind.config.js'
	/* ... */
    },
    buildOptions: {
	/* ... */
    },
};
