import { z } from 'zod';
import { BRAZIL_TIME_ZONE_IDS } from '../salon/brazil-timezones';
import { isUsableSalonSlug } from '../salon/slug';
import { displayText } from './text';

/**
 * Formulário "Criar salão" (E1.3 + E2.1). Estrito: ids, tenant, papel e status nunca vêm do
 * cliente (o servidor gera e decide). O slug da unidade é derivado no servidor.
 */
export const createSalonSchema = z.strictObject({
  salonName: displayText({ min: 2, max: 120 }),
  salonSlug: z.string({ error: 'Informe o endereço.' }).refine(isUsableSalonSlug, {
    error:
      'Use de 3 a 63 letras minúsculas, números ou hífens (sem acento, sem CPF ou telefone). Alguns nomes são reservados.',
  }),
  locationName: displayText({ min: 2, max: 120 }),
  timezone: z.enum(BRAZIL_TIME_ZONE_IDS, { error: 'Escolha o fuso da unidade na lista.' }),
});
export type CreateSalonInput = z.infer<typeof createSalonSchema>;
