/**
 * Liveness: responde se o processo atende HTTP. Público e sem autenticação, por isso não expõe
 * versão, commit, uptime, hostname nem estado de dependências (banco, fila). Um readiness com
 * checagem de dependências, quando existir, fica atrás de autenticação de infraestrutura.
 */
import { connection } from 'next/server';

export async function GET(): Promise<Response> {
  // Sempre executado na requisição: um health check pré-renderizado ou em cache não prova nada.
  // connection() vale também com Cache Components, que pré-renderiza GETs sem dados da requisição.
  await connection();
  return Response.json(
    { status: 'ok' },
    { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
  );
}
