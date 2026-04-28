import { createTRPCRouter, publicProcedure, protectedProcedure } from '@/server/api/trpc';
import { z } from 'zod';

export const ordersRouter = createTRPCRouter({
  list: publicProcedure.query(async () => []),
  byId: publicProcedure.input(z.object({ id: z.string() })).query(async () => null),
  create: protectedProcedure
    .input(z.object({ note: z.string() }))
    .mutation(async () => ({ id: '1' })),
});
