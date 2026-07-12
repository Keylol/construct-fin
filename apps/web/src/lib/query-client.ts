'use client';

import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/Toaster';

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Что-то пошло не так';
}

let _client: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (!_client) {
    _client = new QueryClient({
      // Глобальная обратная связь об ошибках: упавший запрос/мутация никогда не
      // проходят беззвучно (иначе пустая таблица выглядит как «данных нет»).
      // id дедуплицирует тосты при ретраях и параллельных запросах одного ключа.
      queryCache: new QueryCache({
        onError: (error, query) => {
          toast.error('Не удалось загрузить данные', {
            id: `query-error:${query.queryHash}`,
            description: errorMessage(error),
          });
        },
      }),
      mutationCache: new MutationCache({
        onError: (error, _vars, _ctx, mutation) => {
          toast.error('Не удалось сохранить', {
            id: `mutation-error:${mutation.mutationId}`,
            description: errorMessage(error),
          });
        },
      }),
      defaultOptions: {
        queries: {
          retry: 1,
          staleTime: 30_000,
          refetchOnWindowFocus: false,
        },
        mutations: {
          retry: 0,
        },
      },
    });
  }
  return _client;
}
