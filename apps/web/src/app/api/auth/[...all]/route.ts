import { env } from '../../../../env';
import { getAuth } from '../../../../server/auth';
import { createAuthRouteHandler } from '../../../../server/auth/route-handler';

// Autenticação nunca é estática nem cacheada.
export const dynamic = 'force-dynamic';

const handle = createAuthRouteHandler({
  appEnv: env.APP_ENV,
  handle: (request) => getAuth().handler(request),
});

export const GET = handle;
export const POST = handle;
