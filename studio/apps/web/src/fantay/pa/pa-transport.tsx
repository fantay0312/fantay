// SPDX-License-Identifier: AGPL-3.0-only
// Injectable request function. Production uses paRequest; the pa-lab bench injects fixtures.
// Tests keep mocking './pa-api', which still works because the default reads paRequest.
import { createContext, useContext, type ReactNode } from 'react';
import { paRequest } from './pa-api';
import type { PaTransport } from './pa-types';

const PaTransportContext = createContext<PaTransport | null>(null);

export function PaTransportProvider({ transport, children }: { transport: PaTransport; children: ReactNode }) {
  return <PaTransportContext.Provider value={transport}>{children}</PaTransportContext.Provider>;
}

// Forward exactly the arguments the caller passed, so mocks see the same call shape as before.
const defaultTransport: PaTransport = <T,>(...args: Parameters<PaTransport>) => paRequest<T>(...args);

export function usePaTransport(): PaTransport {
  return useContext(PaTransportContext) ?? defaultTransport;
}
