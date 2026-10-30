/* eslint-disable security/detect-non-literal-fs-filename -- caminhos de uma pasta temporária criada pelo próprio teste. */
import { lstat, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { createOutboxMailer, MailTransportUnavailableError, unavailableMailer } = await import(
  './mailer'
);

const MESSAGE = {
  to: 'dona@example.test',
  subject: 'Confirme seu e-mail',
  text: 'link',
  html: '<p>link</p>',
};

describe('outbox em arquivo (dev/test/e2e)', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'salon-mailer-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('grava cada mensagem num arquivo novo, só legível pelo dono (0600, pasta 0700)', async () => {
    const dir = join(base, 'outbox');
    const mailer = createOutboxMailer(dir);
    expect(mailer.available).toBe(true);
    await mailer.send(MESSAGE);
    await mailer.send(MESSAGE);

    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    for (const file of files) {
      expect((await lstat(join(dir, file))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(join(dir, file), 'utf8'))).toMatchObject(MESSAGE);
    }
  });

  it('o nome do arquivo é aleatório e não contém o destinatário', async () => {
    const dir = join(base, 'outbox');
    await createOutboxMailer(dir).send(MESSAGE);
    const [file] = await readdir(dir);
    expect(file).toMatch(/^\d{13}-[0-9a-f-]{36}\.json$/);
    expect(file).not.toContain('dona');
  });

  it('recusa pasta que é link simbólico (não escreve através dele)', async () => {
    const real = join(base, 'real');
    const link = join(base, 'link');
    await createOutboxMailer(real).send(MESSAGE);
    await symlink(real, link);
    await expect(createOutboxMailer(link).send(MESSAGE)).rejects.toThrow(/link simbólico/);
    expect(await readdir(real)).toHaveLength(1);
  });
});

describe('sem provedor (preview/production nesta iteração)', () => {
  it('não está disponível e falha fechado ao enviar', async () => {
    expect(unavailableMailer.available).toBe(false);
    await expect(unavailableMailer.send(MESSAGE)).rejects.toBeInstanceOf(
      MailTransportUnavailableError,
    );
  });
});
