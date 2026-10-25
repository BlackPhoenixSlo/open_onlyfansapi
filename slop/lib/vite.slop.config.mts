// The web app's own Vite config, with the dev proxy pointed at the slop stack's API ($SLOP_API_ORIGIN) and the dev
// server on $SLOP_WEB_PORT. Run from apps/web: `vite --config ../../slop/lib/vite.slop.config.mts`. apps/web is untouched.
import base from '../../apps/web/vite.config.ts';

const api = process.env.SLOP_API_ORIGIN;
const port = Number(process.env.SLOP_WEB_PORT);
if (!api || !port) throw new Error('SLOP_API_ORIGIN and SLOP_WEB_PORT must be set');

export default {
  ...base,
  // The slop run's evidence must not trigger reloads; nothing outside apps/web is served.
  server: {
    ...base.server,
    host: 'localhost',
    port,
    strictPort: true,
    proxy: { '/api': api, '/v1': api, '/openapi.json': api, '/docs': api },
  },
};
