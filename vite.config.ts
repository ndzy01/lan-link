import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const home = env.VITE_PROJECT_HOME_URL || 'https://github.com/ndzy01/lan-link';
  const escapedHome = home.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return {
    base: './',
    plugins: [{
      name: 'lan-link-project-home',
      transformIndexHtml: (html) => html.replaceAll('__PROJECT_HOME__', escapedHome),
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/') return next();
          response.writeHead(302, { Location: '/demo/' });
          response.end();
        });
      },
    }],
    build: {
      outDir: 'demo-dist',
      rollupOptions: { input: fileURLToPath(new URL('./demo/index.html', import.meta.url)) },
    },
    test: { include: ['tests/**/*.test.ts'] },
  };
});
