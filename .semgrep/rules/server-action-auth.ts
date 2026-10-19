'use server';
// Fixture de `semgrep --test` para server-action-auth. Código inseguro de propósito.

declare function requireTenantSession(): Promise<{ readonly tenantId: string }>;
declare function cancelAppointment(tenantId: string, id: string): Promise<void>;
declare const actionClient: { action: (fn: () => Promise<void>) => unknown };
declare const tenantAction: { action: (fn: () => Promise<void>) => unknown };

// ruleid: server-action-auth
export async function deleteCustomer(tenantId: string, customerId: string): Promise<void> {
  await cancelAppointment(tenantId, customerId);
}

// ruleid: server-action-auth
export const updatePrice = async (serviceId: string): Promise<void> => {
  await cancelAppointment('tenant', serviceId);
};

// ruleid: server-action-auth
export async function lateGuard(appointmentId: string): Promise<void> {
  await cancelAppointment('tenant', appointmentId);
  await requireTenantSession();
}

// ruleid: server-action-auth
export const publicCancel = actionClient.action(async () => {
  await cancelAppointment('tenant', 'id');
});

// ok: server-action-auth
export async function cancel(appointmentId: string): Promise<void> {
  const session = await requireTenantSession();
  await cancelAppointment(session.tenantId, appointmentId);
}

// ok: server-action-auth
export async function cancelDestructured(appointmentId: string): Promise<void> {
  const { tenantId } = await requireTenantSession();
  await cancelAppointment(tenantId, appointmentId);
}

// ok: server-action-auth
export const confirm = tenantAction.action(async () => {
  await cancelAppointment('tenant', 'id');
});

// ok: server-action-auth
async function notExported(): Promise<void> {
  await cancelAppointment('tenant', 'id');
}

export function Page(): unknown {
  // ruleid: server-action-auth
  async function inlineAction(formData: FormData): Promise<void> {
    'use server';
    await cancelAppointment('tenant', String(formData.get('id')));
  }

  // ok: server-action-auth
  async function inlineGuarded(formData: FormData): Promise<void> {
    'use server';
    const session = await requireTenantSession();
    await cancelAppointment(session.tenantId, String(formData.get('id')));
  }

  // ruleid: server-action-auth
  const inlineArrow = async (formData: FormData): Promise<void> => {
    'use server';
    await cancelAppointment('tenant', String(formData.get('id')));
  };

  // ruleid: server-action-auth
  const inlineExpression = async (formData: FormData): Promise<void> => {
    'use server';
    await cancelAppointment('tenant', String(formData.get('id')));
  };

  // ok: server-action-auth
  const inlineArrowGuarded = async (formData: FormData): Promise<void> => {
    'use server';
    const session = await requireTenantSession();
    await cancelAppointment(session.tenantId, String(formData.get('id')));
  };

  // Sem a diretiva 'use server' não é Server Action.
  // ok: server-action-auth
  const plainHandler = async (formData: FormData): Promise<void> => {
    await cancelAppointment('tenant', String(formData.get('id')));
  };

  return [
    inlineAction,
    inlineGuarded,
    notExported,
    inlineArrow,
    inlineExpression,
    inlineArrowGuarded,
    plainHandler,
  ];
}
