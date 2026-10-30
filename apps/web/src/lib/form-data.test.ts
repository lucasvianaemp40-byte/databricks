import { describe, expect, it } from 'vitest';
import { formFields } from './form-data';

describe('formFields', () => {
  it('devolve os campos de texto e ignora os internos do React/Next', () => {
    const data = new FormData();
    data.set('salonName', 'Salão');
    data.set('$ACTION_ID_abc', '');
    data.set('$ACTION_REF_1', '');
    expect(formFields(data)).toEqual({ salonName: 'Salão' });
  });

  it('recusa arquivo e chave repetida', () => {
    const withFile = new FormData();
    withFile.set('salonName', new Blob(['x']));
    expect(formFields(withFile)).toBeNull();
    const repeated = new FormData();
    repeated.append('salonName', 'a');
    repeated.append('salonName', 'b');
    expect(formFields(repeated)).toBeNull();
  });
});
