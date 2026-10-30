import 'server-only';
import { env } from '../../env';
import { authDb } from '../db';
import { serverEnv } from '../env';
import { createOutboxMailer, unavailableMailer } from '../mail/mailer';
import { type Auth, createAuth } from './config';

let instance: Auth | undefined;

/** Instância única do Better Auth, criada no primeiro uso (nunca no `next build`). */
export function getAuth(): Auth {
  if (instance === undefined) {
    const config = serverEnv();
    instance = createAuth({
      appUrl: env.APP_URL,
      secret: config.betterAuthSecret,
      authDb: authDb(),
      mailer:
        config.mailOutboxDir === undefined
          ? unavailableMailer
          : createOutboxMailer(config.mailOutboxDir),
    });
  }
  return instance;
}
