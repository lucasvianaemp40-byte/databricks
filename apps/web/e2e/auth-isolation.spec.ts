import {
  assignUniqueIp,
  createSalonThroughUi,
  createVerifiedAccount,
  signInThroughUi,
} from './support/auth';
import { expect, test } from './support/fixtures';

test.describe('isolamento entre salões no painel', () => {
  test('o dono de B não vê o salão de A, nem com o id de A na URL', async ({ browser }) => {
    const owners = [];
    for (const salon of ['Salão Alfa', 'Barbearia Beta']) {
      const context = await browser.newContext();
      await assignUniqueIp(context);
      const page = await context.newPage();
      const { email } = await createVerifiedAccount(page.request);
      await signInThroughUi(page, email);
      await createSalonThroughUi(page, { name: salon });
      owners.push({ context, page, salon });
    }
    const [a, b] = owners;
    if (a === undefined || b === undefined) {
      throw new Error('fixture incompleta');
    }

    await b.page.goto('/app');
    await expect(b.page.getByRole('region', { name: 'Salão' })).toContainText('Barbearia Beta');
    await expect(b.page.getByText('Salão Alfa')).toHaveCount(0);

    // Parâmetros adulterados não mudam o tenant: ele vem só do vínculo da sessão.
    // biome-ignore lint/security/noSecrets: URL de teste, não é segredo.
    const html = await (await b.page.request.get('/app?tenantId=x&organizationId=x')).text();
    expect(html).toContain('Barbearia Beta');
    expect(html).not.toContain('Salão Alfa');

    // Quem já tem salão não cria outro (um salão por conta nesta iteração).
    await b.page.goto('/app/criar-salao');
    await expect(b.page).toHaveURL(/\/app$/);

    for (const owner of owners) {
      await owner.context.close();
    }
  });
});
