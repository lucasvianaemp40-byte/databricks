'use client';

/**
 * Erro inesperado ao renderizar uma rota (abaixo do layout raiz). Em produção o Next não envia
 * a mensagem de erros do servidor ao navegador, só o `digest`, que liga a tela ao log do
 * servidor; mostramos o código para o atendimento poder localizar o problema.
 */
export default function RouteError({
  error,
  retry,
}: Readonly<{ error: Error & { digest?: string }; retry: () => void }>) {
  return (
    <section aria-labelledby="titulo-erro" className="mx-auto max-w-5xl px-4 py-24 sm:px-6">
      <h1 id="titulo-erro" className="font-bold text-3xl tracking-tight">
        Não foi possível carregar esta página
      </h1>
      <p className="mt-4 max-w-xl text-zinc-700 dark:text-zinc-300">
        Tente de novo em instantes. Se o problema continuar, fale com o salão.
      </p>
      {error.digest === undefined ? null : (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Código do erro: <code>{error.digest}</code>
        </p>
      )}
      <button
        type="button"
        onClick={retry}
        className="mt-8 inline-flex min-h-11 items-center rounded-md bg-rose-700 px-5 font-medium text-white hover:bg-rose-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 dark:bg-rose-300 dark:text-zinc-950 dark:hover:bg-rose-200 dark:focus-visible:outline-rose-300"
      >
        Tentar de novo
      </button>
    </section>
  );
}
