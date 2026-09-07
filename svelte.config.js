import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      out: 'build',
      precompress: true
    }),
    // Let SvelteKit attach a fresh nonce to its inline hydration bootstrap.
    // A hand-written `script-src 'self'` header blocks that bootstrap and leaves
    // server-rendered controls inert in production.
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'base-uri': ['none'],
        'connect-src': ['self'],
        'font-src': ['self'],
        'form-action': ['self'],
        'frame-ancestors': ['none'],
        'img-src': ['self', 'data:'],
        'object-src': ['none'],
        'script-src': ['self'],
        'style-src': ['self', 'unsafe-inline']
      }
    }
  }
};

export default config;
