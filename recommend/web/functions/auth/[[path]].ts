export const onRequest: PagesFunction<{ RECOMMEND_API: Fetcher }> = (context) =>
  context.env.RECOMMEND_API.fetch(context.request);
