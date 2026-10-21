// HTTP wrapper (Express) of the API. The logic lives in api.js (tested without Express).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { statusFor } from './api.js';

/**
 * @param express  express module (injected: the import is in scripts/serve.js)
 * @param api      createApi(...)
 * @param opts.staticDir  folder of the built frontend (web/dist); if it does not exist, only the API is served
 */
export function createApp(express, api, { staticDir } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      const status = statusFor(err);
      if (status === 500) console.error(err);
      res.status(status).json({ error: err.name, message: err.message });
    }
  };

  // Metadata
  app.get('/api/meta', handle(() => api.meta()));
  // Agent tools (aggregates only)
  app.get('/api/tools', handle(() => api.tools()));
  app.get('/api/metrics', handle(() => api.listMetrics()));
  app.get('/api/questions', handle(() => api.questions()));
  app.post('/api/query', handle((req) => api.queryMetric(req.body, { source: req.get('x-odin-source') === 'agent' ? 'agent' : 'ui' })));
  // UI only (rows): never exposed to the agent
  app.get('/api/keys', handle((req) => api.listKeys(req.query)));
  app.get('/api/keys/:keyId', handle((req) => api.getKey(req.params.keyId, req.query)));
  app.use('/api', (req, res) => res.status(404).json({ error: 'NotFound', message: `Unknown route: ${req.path}` }));

  if (staticDir && existsSync(resolve(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    // SPA: any other GET returns index.html
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(resolve(staticDir, 'index.html')) : next()));
  }
  return app;
}
